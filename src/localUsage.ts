import { promises as fs } from 'fs';
import * as path from 'path';
import { projectsDir } from './paths';
import { costOf, TokenCounts } from './pricing';

/**
 * Token usage computed from Claude Code's local transcripts (~/.claude/projects/**\/*.jsonl).
 * Files are read incrementally: only bytes appended since the previous scan are parsed.
 */

const RETENTION_MS = 8 * 24 * 3600 * 1000;
const CHUNK = 4 * 1024 * 1024;

interface Entry {
  ts: number;
  model: string;
  sessionId?: string;
  tokens: TokenCounts;
}

export interface Aggregate extends TokenCounts {
  cost: number;
  /** true when at least one model had no known price, so `cost` is a lower bound */
  costPartial: boolean;
  messages: number;
}

const emptyAggregate = (): Aggregate => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  cost: 0,
  costPartial: false,
  messages: 0,
});

export const totalTokens = (t: TokenCounts) => t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;

export class LocalUsageScanner {
  private offsets = new Map<string, number>();
  // Keyed by message id + request id: streamed messages are written as several lines sharing one usage.
  private entries = new Map<string, Entry>();
  private scanning: Promise<void> | undefined;

  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async doScan() {
    const cutoff = Date.now() - RETENTION_MS;
    const files = await listJsonl(projectsDir(), cutoff);
    for (const file of files) {
      try {
        await this.readNew(file);
      } catch {
        // file rotated or deleted mid-scan: pick it up next time
      }
    }
    for (const [key, e] of this.entries) if (e.ts < cutoff) this.entries.delete(key);
  }

  private async readNew(file: string) {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      let offset = this.offsets.get(file) ?? 0;
      if (size < offset) offset = 0; // truncated/rewritten
      // Split on newline bytes (not decoded text) so multi-byte characters across chunks stay intact.
      let consumed = offset;
      let pending = Buffer.alloc(0);
      while (offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        const data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl === -1) {
          pending = data;
          continue;
        }
        for (const line of data.toString('utf8', 0, lastNl).split('\n')) this.ingest(line);
        consumed = offset - (data.length - lastNl - 1);
        pending = Buffer.from(data.subarray(lastNl + 1));
      }
      // An incomplete trailing line is re-read once it is finished.
      this.offsets.set(file, consumed);
    } finally {
      await handle.close();
    }
  }

  private ingest(line: string) {
    if (!line.includes('"usage"')) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const msg = d?.message;
    const u = msg?.usage;
    if (d.type !== 'assistant' || !u || !msg.model || msg.model === '<synthetic>') return;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const key = `${msg.id ?? d.uuid}:${d.requestId ?? ''}`;
    this.entries.set(key, {
      ts: Date.parse(d.timestamp) || Date.now(),
      model: msg.model,
      sessionId: d.sessionId,
      tokens: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite1h: cw1h,
        cacheWrite5m: Math.max(0, cacheCreation - cw1h),
        cacheRead: u.cache_read_input_tokens ?? 0,
      },
    });
  }

  aggregate(filter: (e: Entry) => boolean): Aggregate {
    const agg = emptyAggregate();
    for (const e of this.entries.values()) {
      if (!filter(e)) continue;
      add(agg, e);
    }
    return agg;
  }

  since(ts: number) {
    return this.aggregate((e) => e.ts >= ts);
  }

  forSession(sessionId: string) {
    return this.aggregate((e) => e.sessionId === sessionId);
  }

  byModelSince(ts: number): Map<string, Aggregate> {
    const out = new Map<string, Aggregate>();
    for (const e of this.entries.values()) {
      if (e.ts < ts) continue;
      let agg = out.get(e.model);
      if (!agg) out.set(e.model, (agg = emptyAggregate()));
      add(agg, e);
    }
    return out;
  }
}

function add(agg: Aggregate, e: Entry) {
  agg.input += e.tokens.input;
  agg.output += e.tokens.output;
  agg.cacheWrite5m += e.tokens.cacheWrite5m;
  agg.cacheWrite1h += e.tokens.cacheWrite1h;
  agg.cacheRead += e.tokens.cacheRead;
  agg.messages++;
  const c = costOf(e.model, e.tokens);
  if (c === undefined) agg.costPartial = true;
  else agg.cost += c;
}

async function listJsonl(dir: string, modifiedAfter: number): Promise<string[]> {
  const out: string[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== 'memory' && d.name !== 'tool-results') out.push(...(await listJsonl(full, modifiedAfter)));
    } else if (d.name.endsWith('.jsonl')) {
      try {
        if ((await fs.stat(full)).mtimeMs >= modifiedAfter) out.push(full);
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}
