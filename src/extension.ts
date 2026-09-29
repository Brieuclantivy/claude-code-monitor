import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fmt from './format';
import { LocalUsageScanner } from './localUsage';
import { fetchPlanUsage, PlanUsageResult } from './planUsage';
import { listLiveSessions, LiveSession, SessionSummary, summarize } from './sessions';
import { renderSessionsItem, renderUsageItem, sessionTitle, stateIcon, stateLabel } from './statusBar';
import { SummaryPanel } from './summaryPanel';

const t = vscode.l10n.t;

const SESSIONS_POLL_MS = 2000;
const LOCAL_SCAN_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export function activate(context: vscode.ExtensionContext) {
  const monitor = new Monitor(context);
  context.subscriptions.push(monitor);
  monitor.start();
}

export function deactivate() {}

class Monitor implements vscode.Disposable {
  private sessionsItem = vscode.window.createStatusBarItem('claudeMonitor.sessions', vscode.StatusBarAlignment.Right, 1000);
  private usageItem = vscode.window.createStatusBarItem('claudeMonitor.usage', vscode.StatusBarAlignment.Right, 999);
  private local = new LocalUsageScanner();
  private panel = new SummaryPanel();
  private timers: NodeJS.Timeout[] = [];
  private disposables: vscode.Disposable[] = [];

  private sessions: LiveSession[] = [];
  private summaries = new Map<string, SessionSummary>();
  private summaryMtimes = new Map<string, number>();
  private previousStates: Map<string, LiveSession['state']> | undefined;

  private plan: PlanUsageResult | undefined;
  private nextPlanFetch = 0;
  private planFailures = 0;
  private polling = false;

  constructor(private context: vscode.ExtensionContext) {
    this.sessionsItem.name = 'Claude Code · ' + t('Conversations');
    this.sessionsItem.command = 'claudeMonitor.showSessions';
    this.usageItem.name = 'Claude Code · ' + t('Usage');
    this.usageItem.command = 'claudeMonitor.refresh';
    this.usageItem.text = '$(pulse) …';
    this.usageItem.show();

    this.disposables.push(
      this.sessionsItem,
      this.usageItem,
      vscode.commands.registerCommand('claudeMonitor.showSessions', () => this.pickSession()),
      vscode.commands.registerCommand('claudeMonitor.refresh', () => this.refreshAll(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeMonitor')) this.refreshAll(false);
      }),
    );
  }

  private get config() {
    return vscode.workspace.getConfiguration('claudeMonitor');
  }

  start() {
    this.refreshAll(false);
    this.timers.push(
      setInterval(() => this.pollSessions(), SESSIONS_POLL_MS),
      setInterval(() => this.local.scan().then(() => this.renderUsage()), LOCAL_SCAN_MS),
      setInterval(() => this.pollPlan(false), 15_000),
    );
  }

  private async refreshAll(force: boolean) {
    await Promise.all([this.pollSessions(), this.local.scan(), this.pollPlan(force)]);
    this.renderUsage();
  }

  // ------------------------------------------------------------ subscription usage

  private get planCacheFile() {
    return path.join(this.context.globalStorageUri.fsPath, 'plan-usage.json');
  }

  private async pollPlan(force: boolean) {
    if (!this.config.get<boolean>('planUsage.enabled', true)) {
      this.plan = undefined;
      this.renderUsage();
      return;
    }
    const now = Date.now();
    if (!force && now < this.nextPlanFetch) return;
    const interval = Math.max(60, this.config.get<number>('planUsage.refreshSeconds', 120)) * 1000;

    // Several VS Code windows share one cached result so the endpoint is not hit once per window.
    if (!force) {
      const cached = await this.readPlanCache();
      if (cached && now - cached.at < interval) {
        this.plan = cached.result;
        this.nextPlanFetch = cached.at + interval;
        this.renderUsage();
        return;
      }
    }

    const result = await fetchPlanUsage();
    if (result.ok || result.reason === 'no-credentials') {
      this.planFailures = 0;
      this.plan = result;
      this.nextPlanFetch = Date.now() + interval;
    } else {
      this.planFailures++;
      // Keep showing the last good numbers during transient errors.
      if (!this.plan?.ok || result.reason === 'expired' || result.reason === 'unauthorized') this.plan = result;
      this.nextPlanFetch = Date.now() + Math.min(MAX_BACKOFF_MS, interval * 2 ** (this.planFailures - 1));
    }
    await this.writePlanCache(this.plan!);
    this.renderUsage();
  }

  private async readPlanCache(): Promise<{ at: number; result: PlanUsageResult } | undefined> {
    try {
      const d = JSON.parse(await fs.readFile(this.planCacheFile, 'utf8'));
      if (d?.result?.ok) {
        const u = d.result.usage;
        u.fetchedAt = new Date(u.fetchedAt);
        for (const k of ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet']) {
          if (u[k]?.resetsAt) u[k].resetsAt = new Date(u[k].resetsAt);
        }
      }
      return d;
    } catch {
      return undefined;
    }
  }

  private async writePlanCache(result: PlanUsageResult) {
    try {
      await fs.mkdir(path.dirname(this.planCacheFile), { recursive: true });
      await fs.writeFile(this.planCacheFile, JSON.stringify({ at: Date.now(), result }));
    } catch {
      /* cache is best effort */
    }
  }

  private renderUsage() {
    renderUsageItem(this.usageItem, {
      plan: this.plan,
      local: this.local,
      warningThreshold: this.config.get<number>('warningThreshold', 80),
    });
  }

  // ------------------------------------------------------------ sessions

  private inWorkspace(cwd: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => {
      const rel = path.relative(f.uri.fsPath, cwd);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  private async pollSessions() {
    if (this.polling) return;
    this.polling = true;
    try {
      let sessions = await listLiveSessions();
      if (this.config.get<string>('sessions.scope') === 'workspace') sessions = sessions.filter((s) => this.inWorkspace(s.cwd));

      await Promise.all(sessions.map((s) => this.refreshSummary(s)));
      const liveIds = new Set(sessions.map((s) => s.sessionId));
      for (const id of [...this.summaries.keys()]) {
        if (!liveIds.has(id)) {
          this.summaries.delete(id);
          this.summaryMtimes.delete(id);
        }
      }

      this.notifyTransitions(sessions);
      this.sessions = sessions;
      renderSessionsItem(this.sessionsItem, sessions, this.summaries);

      if (this.panel.visible && this.panel.sessionId) {
        const s = sessions.find((x) => x.sessionId === this.panel.sessionId);
        this.panel.update(s, s && this.summaries.get(s.sessionId), s && this.local.forSession(s.sessionId));
      }
    } finally {
      this.polling = false;
    }
  }

  /** Re-reads a transcript only when it changed since the last poll. */
  private async refreshSummary(s: LiveSession) {
    const mtimeOf = (file: string) => fs.stat(file).then((st) => st.mtimeMs, () => undefined);
    const known = this.summaries.get(s.sessionId)?.transcriptPath;
    // Stat before reading, so a write landing during the read triggers another read next poll.
    let mtime = known ? await mtimeOf(known) : undefined;
    if (mtime !== undefined && mtime === this.summaryMtimes.get(s.sessionId)) return;
    const summary = await summarize(s);
    if (mtime === undefined && summary.transcriptPath) mtime = await mtimeOf(summary.transcriptPath);
    this.summaries.set(s.sessionId, summary);
    if (mtime !== undefined) this.summaryMtimes.set(s.sessionId, mtime);
  }

  private notifyTransitions(sessions: LiveSession[]) {
    const prev = this.previousStates;
    this.previousStates = new Map(sessions.map((s) => [s.sessionId, s.state]));
    if (!prev) return; // first poll: nothing changed, it's just the startup state

    let finished = false;
    for (const s of sessions) {
      const before = prev.get(s.sessionId);
      if (!before || before === s.state) continue;
      if (before === 'working' && s.state !== 'working') finished = true;
      // Each window only notifies about its own conversations, so the same alert doesn't pop in every window.
      if (!this.inWorkspace(s.cwd)) continue;
      const title = sessionTitle(s, this.summaries.get(s.sessionId));
      if (s.state === 'waiting' && this.config.get<boolean>('notifications.onWaiting', true)) {
        this.notify(s, t('Claude is waiting for you: {0}', title));
      } else if (s.state === 'idle' && before === 'working' && this.config.get<boolean>('notifications.onDone', false)) {
        this.notify(s, t('Claude finished: {0}', title));
      }
    }
    // A finished turn means new usage: pick it up now rather than at the next scan.
    if (finished) {
      this.local.scan().then(() => this.renderUsage());
      this.nextPlanFetch = Math.min(this.nextPlanFetch, Date.now() + 5000);
    }
  }

  private async notify(s: LiveSession, message: string) {
    const show = t('Show summary');
    if ((await vscode.window.showInformationMessage(message, show)) === show) this.openSummary(s);
  }

  private async pickSession() {
    if (this.sessions.length === 0) {
      vscode.window.showInformationMessage(t('No Claude Code conversation is open in VS Code.'));
      return;
    }
    if (this.sessions.length === 1) return this.openSummary(this.sessions[0]);

    const now = Date.now();
    const items = this.sessions.map((s) => {
      const sum = this.summaries.get(s.sessionId);
      const since = s.statusSince ? ` · ${fmt.duration(now - s.statusSince)}` : '';
      return {
        label: `${stateIcon[s.state]} ${sessionTitle(s, sum)}`,
        description: `${stateLabel(s)}${since}`,
        detail: `${path.basename(s.cwd)}${sum?.lastPrompt ? ' — ' + sum.lastPrompt.replace(/\s+/g, ' ').slice(0, 140) : ''}`,
        session: s,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Claude Code conversations'),
      placeHolder: t('Select a conversation to see its summary'),
      matchOnDetail: true,
    });
    if (picked) this.openSummary(picked.session);
  }

  private async openSummary(s: LiveSession) {
    await this.local.scan();
    const summary = this.summaries.get(s.sessionId) ?? (await summarize(s));
    this.panel.show(s, summary, this.local.forSession(s.sessionId));
  }

  dispose() {
    this.timers.forEach(clearInterval);
    this.disposables.forEach((d) => d.dispose());
  }
}
