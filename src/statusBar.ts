import * as path from 'path';
import * as vscode from 'vscode';
import * as fmt from './format';
import { Aggregate, LocalUsageScanner, totalTokens } from './localUsage';
import { PlanUsage, PlanUsageResult } from './planUsage';
import { LiveSession, SessionSummary } from './sessions';

const t = vscode.l10n.t;

export const stateIcon = { working: '$(loading~spin)', waiting: '$(bell-dot)', idle: '$(check)' } as const;

export function stateLabel(s: LiveSession): string {
  if (s.state === 'working') return t('Working');
  if (s.state === 'waiting') return s.waitingFor ? t('Waiting for you ({0})', s.waitingFor) : t('Waiting for you');
  return t('Idle');
}

export function sessionTitle(s: LiveSession, summary?: SessionSummary): string {
  return summary?.title || s.name || path.basename(s.cwd) || s.sessionId.slice(0, 8);
}

// ---------------------------------------------------------------- sessions item

export function renderSessionsItem(item: vscode.StatusBarItem, sessions: LiveSession[], summaries: Map<string, SessionSummary>) {
  if (sessions.length === 0) {
    item.hide();
    return;
  }
  const working = sessions.filter((s) => s.state === 'working').length;
  const waiting = sessions.filter((s) => s.state === 'waiting').length;
  const idle = sessions.length - working - waiting;

  const parts: string[] = [];
  if (working) parts.push(`${stateIcon.working} ${working}`);
  if (waiting) parts.push(`${stateIcon.waiting} ${waiting}`);
  if (!working && !waiting) parts.push(`${stateIcon.idle} ${idle}`);
  item.text = parts.join('  ');
  item.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeMonitor.showSessions'] };
  md.appendMarkdown(`**${t('Claude Code conversations')}**\n\n`);
  const now = Date.now();
  for (const s of sessions) {
    const sum = summaries.get(s.sessionId);
    const since = s.statusSince ? ` · ${fmt.duration(now - s.statusSince)}` : '';
    md.appendMarkdown(`${stateIcon[s.state]} **${fmt.escapeMd(sessionTitle(s, sum))}** — ${fmt.escapeMd(stateLabel(s))}${since}  \n`);
    const detail =
      s.state === 'working' && sum?.currentTool
        ? `${sum.currentTool.tool}${sum.currentTool.detail ? ': ' + sum.currentTool.detail : ''}`
        : path.basename(s.cwd);
    md.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;_${fmt.escapeMd(detail)}_\n\n`);
  }
  md.appendMarkdown(`---\n[${t('Click for the task summary')}](command:claudeMonitor.showSessions)`);
  item.tooltip = md;
  item.show();
}

// ---------------------------------------------------------------- usage item

export interface UsageView {
  plan?: PlanUsageResult;
  local: LocalUsageScanner;
  warningThreshold: number;
}

function planError(r: Exclude<PlanUsageResult, { ok: true }>): string {
  switch (r.reason) {
    case 'no-credentials':
      return t('No Claude Code login found (subscription limits need a Claude Pro/Max/Team login).');
    case 'expired':
    case 'unauthorized':
      return t('Claude Code login expired: send a message in Claude Code to refresh it.');
    case 'rate-limited':
      return t('Rate limited by the usage endpoint, retrying later.');
    case 'network':
      return t('Network error while fetching limits.');
    default:
      return t('Could not read subscription limits ({0}).', r.detail ?? '?');
  }
}

export function renderUsageItem(item: vscode.StatusBarItem, v: UsageView) {
  const plan = v.plan?.ok ? v.plan.usage : undefined;
  const now = Date.now();

  // Local windows aligned with the subscription windows when known.
  const fiveHourStart = plan?.fiveHour?.resetsAt ? plan.fiveHour.resetsAt.getTime() - 5 * 3600e3 : now - 5 * 3600e3;
  const weekStart = plan?.sevenDay?.resetsAt ? plan.sevenDay.resetsAt.getTime() - 7 * 86400e3 : now - 7 * 86400e3;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const local5h = v.local.since(fiveHourStart);
  const localToday = v.local.since(midnight.getTime());
  const localWeek = v.local.since(weekStart);

  if (plan) {
    const segs: string[] = [];
    if (plan.fiveHour) segs.push(`5h ${fmt.percent(plan.fiveHour.percent)}`);
    if (plan.sevenDay) segs.push(`${t('7d')} ${fmt.percent(plan.sevenDay.percent)}`);
    item.text = `$(pulse) ${segs.join(' · ')}`;
    const max = Math.max(plan.fiveHour?.percent ?? 0, plan.sevenDay?.percent ?? 0);
    item.backgroundColor =
      max >= 95
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : max >= v.warningThreshold
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  } else {
    // No subscription data: fall back to today's local tokens.
    item.text = `$(pulse) ${fmt.tokens(totalTokens(localToday))}`;
    item.backgroundColor = undefined;
  }

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeMonitor.refresh'] };
  md.supportHtml = true;

  md.appendMarkdown(`**${t('Subscription limits')}**\n\n`);
  if (plan) appendPlan(md, plan);
  else if (v.plan && !v.plan.ok) md.appendMarkdown(`_${fmt.escapeMd(planError(v.plan))}_\n\n`);
  else md.appendMarkdown(`_${t('Loading…')}_\n\n`);

  md.appendMarkdown(`---\n\n**${t('Tokens (local transcripts)')}**\n\n`);
  md.appendMarkdown(`| | ${t('Input')} | ${t('Output')} | ${t('Cache')} | ${t('API cost')} |\n|:--|--:|--:|--:|--:|\n`);
  const row = (label: string, a: Aggregate) =>
    md.appendMarkdown(
      `| ${label} | ${fmt.tokens(a.input)} | ${fmt.tokens(a.output)} | ${fmt.tokens(a.cacheRead + a.cacheWrite5m + a.cacheWrite1h)} | ${a.costPartial ? '≥ ' : ''}${fmt.usd(a.cost)} |\n`,
    );
  row(t('5h window'), local5h);
  row(t('Today'), localToday);
  row(t('Week'), localWeek);

  const byModel = [...v.local.byModelSince(weekStart)].sort((a, b) => b[1].cost - a[1].cost).slice(0, 4);
  if (byModel.length > 1) {
    md.appendMarkdown(`\n${t('This week by model')}: `);
    md.appendMarkdown(byModel.map(([m, a]) => `\`${m.replace(/^claude-/, '')}\` ${fmt.usd(a.cost)}`).join(' · '));
    md.appendMarkdown('\n');
  }
  md.appendMarkdown(`\n<small>${t('API cost = what these tokens would cost at API list prices; your subscription is not billed this way.')}</small>\n\n`);
  md.appendMarkdown(`[$(refresh) ${t('Refresh')}](command:claudeMonitor.refresh)`);
  if (plan) md.appendMarkdown(` · ${t('updated {0}', fmt.clockTime(plan.fetchedAt))}`);
  item.tooltip = md;
  item.show();
}

function bar(p: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, p)) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function appendPlan(md: vscode.MarkdownString, plan: PlanUsage) {
  const line = (label: string, w?: { percent: number; resetsAt?: Date }) => {
    if (!w) return;
    const reset = w.resetsAt ? ` — ${t('resets {0}', fmt.clockTime(w.resetsAt))}` : '';
    md.appendMarkdown(`${label}: \`${bar(w.percent)}\` **${fmt.percent(w.percent)}**${reset}  \n`);
  };
  line(t('Session (5h)'), plan.fiveHour);
  line(t('Week (all models)'), plan.sevenDay);
  line(t('Week (Opus)'), plan.sevenDayOpus);
  line(t('Week (Sonnet)'), plan.sevenDaySonnet);
  if (plan.extra) {
    md.appendMarkdown(
      `${t('Extra usage')}: \`${bar(plan.extra.percent)}\` ${fmt.money(plan.extra.used, plan.extra.currency)} / ${fmt.money(plan.extra.limit, plan.extra.currency)}  \n`,
    );
  }
  md.appendMarkdown('\n');
}
