import { promises as fs } from 'fs';
import * as path from 'path';
import { projectsDir, sessionsDir } from './paths';

/**
 * Live Claude Code sessions opened from the VS Code extension.
 * Claude Code writes one ~/.claude/sessions/<pid>.json per running process with its status
 * ("busy" | "waiting" | "idle"); the transcript gives the details for the summary.
 */

export type SessionState = 'working' | 'waiting' | 'idle';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  state: SessionState;
  waitingFor?: string;
  startedAt?: number;
  statusSince?: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export interface ToolStep {
  tool: string;
  detail: string;
  ts?: number;
}

export interface SessionSummary {
  title?: string;
  lastPrompt?: string;
  lastPromptAt?: number;
  currentTool?: ToolStep;
  recentSteps: ToolStep[];
  lastAssistantText?: string;
  todos?: TodoItem[];
  model?: string;
  transcriptPath?: string;
}

const VSCODE_ENTRYPOINT = 'claude-vscode';
const TAIL_BYTES = 2 * 1024 * 1024;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

function toState(status: unknown): SessionState {
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'waiting';
  return 'idle';
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          const d = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
          if (d.entrypoint !== VSCODE_ENTRYPOINT || typeof d.pid !== 'number' || !d.sessionId) return;
          if (!isAlive(d.pid)) return;
          out.push({
            pid: d.pid,
            sessionId: d.sessionId,
            cwd: d.cwd ?? '',
            name: d.name,
            state: toState(d.status),
            waitingFor: typeof d.waitingFor === 'string' ? d.waitingFor : undefined,
            startedAt: d.startedAt,
            statusSince: d.statusUpdatedAt,
          });
        } catch {
          /* being rewritten; next poll */
        }
      }),
  );
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// ---------------------------------------------------------------- transcript summary

const transcriptPathCache = new Map<string, string>();
const titleCache = new Map<string, string>();

async function findTranscript(session: LiveSession): Promise<string | undefined> {
  const cached = transcriptPathCache.get(session.sessionId);
  if (cached) return cached;
  const file = `${session.sessionId}.jsonl`;
  const root = projectsDir();
  // Claude Code names the project folder after the cwd with non-alphanumerics replaced by '-'.
  const guess = path.join(root, session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  const candidates = [guess];
  try {
    for (const d of await fs.readdir(root)) candidates.push(path.join(root, d, file));
  } catch {
    return undefined;
  }
  for (const c of candidates) {
    try {
      await fs.access(c);
      transcriptPathCache.set(session.sessionId, c);
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function readTail(file: string): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    return text.split('\n').filter(Boolean);
  } finally {
    await handle.close();
  }
}

/** Strips the context blocks the IDE and harness wrap around the user's actual prompt. */
function cleanPrompt(text: string): string {
  return text
    .replace(/<(ide_selection|ide_opened_file|system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return cleanPrompt(content) || undefined;
  if (!Array.isArray(content)) return undefined;
  if (content.some((c) => c?.type === 'tool_result')) return undefined;
  const text = content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => cleanPrompt(c.text))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function short(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function describeTool(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.questions?.[0]?.question ??
    input.description ??
    input.file_path ??
    input.notebook_path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.query ??
    input.prompt ??
    input.skill ??
    '';
  let detail = typeof pick === 'string' ? pick : JSON.stringify(pick);
  if (typeof input.file_path === 'string') detail = path.basename(input.file_path);
  return short(detail, 100);
}

export async function summarize(session: LiveSession): Promise<SessionSummary> {
  const summary: SessionSummary = { recentSteps: [], title: titleCache.get(session.sessionId) };
  const file = await findTranscript(session);
  if (!file) return summary;
  summary.transcriptPath = file;

  let lines: string[];
  try {
    lines = await readTail(file);
  } catch {
    return summary;
  }

  const pendingTools = new Map<string, ToolStep>();
  let customTitle: string | undefined;
  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // A title the user set by renaming the session wins over the generated one.
    if (d.type === 'custom-title' && d.customTitle) summary.title = customTitle = d.customTitle;
    else if (d.type === 'ai-title' && d.aiTitle && !customTitle) summary.title = d.aiTitle;
    if (d.isSidechain) continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : undefined;

    if (d.type === 'user' && d.message && !d.isMeta) {
      const content = d.message.content;
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === 'tool_result') pendingTools.delete(c.tool_use_id);
      }
      const text = userText(content);
      if (text) {
        summary.lastPrompt = text;
        summary.lastPromptAt = ts;
        // A new prompt starts a new task: earlier steps and answers belong to the previous one.
        summary.recentSteps = [];
        summary.lastAssistantText = undefined;
        pendingTools.clear();
      }
    } else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      if (d.message.model && d.message.model !== '<synthetic>') summary.model = d.message.model;
      for (const c of d.message.content) {
        if (c?.type === 'text' && c.text?.trim()) summary.lastAssistantText = c.text.trim();
        if (c?.type === 'tool_use') {
          const step = { tool: c.name, detail: describeTool(c.name, c.input), ts };
          pendingTools.set(c.id, step);
          summary.recentSteps.push(step);
          if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) summary.todos = c.input.todos;
        }
      }
    }
  }
  summary.currentTool = [...pendingTools.values()].pop();
  summary.recentSteps = summary.recentSteps.slice(-8);
  if (summary.title) titleCache.set(session.sessionId, summary.title);
  return summary;
}
