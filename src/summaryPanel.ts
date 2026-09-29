import * as vscode from 'vscode';
import * as fmt from './format';
import { Aggregate } from './localUsage';
import { LiveSession, SessionSummary } from './sessions';
import { sessionTitle, stateLabel } from './statusBar';

const t = vscode.l10n.t;
const MAX_ANSWER_CHARS = 3000;

/** A single webview showing the raw summary of one session, refreshed while it stays open. */
export class SummaryPanel {
  private panel: vscode.WebviewPanel | undefined;
  private lastHtml = '';
  sessionId: string | undefined;

  show(session: LiveSession, summary: SessionSummary, usage: Aggregate) {
    this.sessionId = session.sessionId;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('claudeMonitor.summary', '', vscode.ViewColumn.Beside, {
        enableScripts: false,
        enableFindWidget: true,
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.sessionId = undefined;
        this.lastHtml = '';
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.update(session, summary, usage);
  }

  get visible() {
    return this.panel !== undefined;
  }

  update(session: LiveSession | undefined, summary: SessionSummary | undefined, usage: Aggregate | undefined) {
    if (!this.panel) return;
    const html = session && summary && usage ? render(session, summary, usage) : renderEnded();
    this.panel.title = session ? `Claude · ${sessionTitle(session, summary)}` : 'Claude';
    // Only re-render on change, so the scroll position is kept between polls.
    if (html !== this.lastHtml) {
      this.lastHtml = html;
      this.panel.webview.html = html;
    }
  }
}

const e = fmt.escapeHtml;

function page(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 16px 24px; line-height: 1.5; }
  h1 { font-size: 1.3em; margin: 0.2em 0 0.1em; }
  h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); margin: 1.6em 0 .4em; }
  .meta { color: var(--vscode-descriptionForeground); }
  .state { display: inline-block; padding: 1px 8px; border-radius: 10px; font-weight: 600; }
  .working { background: var(--vscode-statusBarItem-prominentBackground, #0e639c); color: var(--vscode-statusBarItem-prominentForeground, #fff); }
  .waiting { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
  .idle { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .box { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
  ul { padding-left: 1.2em; margin: 0; }
  li { margin: 2px 0; }
  code { font-family: var(--vscode-editor-font-family); }
  .done { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .now { font-weight: 600; }
  table { border-collapse: collapse; }
  td { padding: 2px 16px 2px 0; }
</style></head><body>${body}</body></html>`;
}

function render(s: LiveSession, sum: SessionSummary, usage: Aggregate): string {
  const now = Date.now();
  const since = s.statusSince ? ` ${t('for {0}', fmt.duration(now - s.statusSince))}` : '';
  let b = `<h1>${e(sessionTitle(s, sum))}</h1>`;
  b += `<div class="meta"><code>${e(s.cwd)}</code>${sum.model ? ` · ${e(sum.model)}` : ''}</div>`;
  b += `<p><span class="state ${s.state}">${e(stateLabel(s))}</span><span class="meta">${e(since)}</span></p>`;

  if (s.state === 'working' && sum.currentTool) {
    b += `<h2>${t('Now')}</h2><div class="box"><code>${e(sum.currentTool.tool)}</code> ${e(sum.currentTool.detail)}</div>`;
  }

  if (sum.lastPrompt) {
    const at = sum.lastPromptAt ? ` <span class="meta">(${t('{0} ago', fmt.duration(now - sum.lastPromptAt))})</span>` : '';
    b += `<h2>${t('Current task')}${at}</h2><div class="box">${e(sum.lastPrompt)}</div>`;
  }

  if (sum.todos?.length) {
    b += `<h2>${t('Plan')}</h2><ul>`;
    for (const td of sum.todos) {
      const cls = td.status === 'completed' ? 'done' : td.status === 'in_progress' ? 'now' : '';
      const mark = td.status === 'completed' ? '☑' : td.status === 'in_progress' ? '▶' : '☐';
      b += `<li class="${cls}">${mark} ${e(td.content)}</li>`;
    }
    b += '</ul>';
  }

  if (sum.recentSteps.length) {
    b += `<h2>${t('Recent steps')}</h2><ul>`;
    for (const st of sum.recentSteps) b += `<li><code>${e(st.tool)}</code> ${e(st.detail)}</li>`;
    b += '</ul>';
  }

  if (sum.lastAssistantText) {
    let text = sum.lastAssistantText;
    if (text.length > MAX_ANSWER_CHARS) text = text.slice(0, MAX_ANSWER_CHARS) + '…';
    b += `<h2>${t("Claude's last message")}</h2><div class="box">${e(text)}</div>`;
  }

  if (usage.messages) {
    b += `<h2>${t('Session usage')}</h2><table>
      <tr><td>${t('Input')}</td><td>${fmt.tokens(usage.input)}</td></tr>
      <tr><td>${t('Output')}</td><td>${fmt.tokens(usage.output)}</td></tr>
      <tr><td>${t('Cache read / write')}</td><td>${fmt.tokens(usage.cacheRead)} / ${fmt.tokens(usage.cacheWrite5m + usage.cacheWrite1h)}</td></tr>
      <tr><td>${t('API cost')}</td><td>${usage.costPartial ? '≥ ' : ''}${fmt.usd(usage.cost)}</td></tr>
    </table>`;
  }

  if (!sum.transcriptPath) b += `<p class="meta">${t('Transcript not found yet.')}</p>`;
  return page(b);
}

function renderEnded(): string {
  return page(`<p class="meta">${t('This conversation has ended.')}</p>`);
}
