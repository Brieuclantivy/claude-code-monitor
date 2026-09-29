import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { credentialsFile } from './paths';

/**
 * Subscription limits, as shown by Claude Code's /usage.
 * Relies on the same (undocumented) endpoint Claude Code calls, authenticated with the
 * OAuth token Claude Code already stored locally. The token is sent to api.anthropic.com only
 * and is never refreshed here, so Claude Code's own session is left untouched.
 */

export interface LimitWindow {
  percent: number;
  resetsAt?: Date;
}

export interface PlanUsage {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  sevenDayOpus?: LimitWindow;
  sevenDaySonnet?: LimitWindow;
  extra?: { used: number; limit: number; currency: string; percent: number };
  fetchedAt: Date;
}

export type PlanUsageResult =
  | { ok: true; usage: PlanUsage }
  | { ok: false; reason: 'no-credentials' | 'expired' | 'unauthorized' | 'rate-limited' | 'network' | 'unexpected'; detail?: string };

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

interface OAuthCreds {
  accessToken: string;
  expiresAt?: number;
}

async function readMacKeychain(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? undefined : stdout.trim()),
    );
  });
}

async function readCredentials(): Promise<OAuthCreds | undefined> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(credentialsFile(), 'utf8');
  } catch {
    if (process.platform === 'darwin') raw = await readMacKeychain();
  }
  if (!raw) return undefined;
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string') return undefined;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return undefined;
  }
}

function toWindow(w: any): LimitWindow | undefined {
  if (!w || typeof w.utilization !== 'number') return undefined;
  return { percent: w.utilization, resetsAt: w.resets_at ? new Date(w.resets_at) : undefined };
}

export async function fetchPlanUsage(): Promise<PlanUsageResult> {
  const creds = await readCredentials();
  if (!creds) return { ok: false, reason: 'no-credentials' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { ok: false, reason: 'expired' };

  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code-monitor-vscode',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e) };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' };
  if (res.status === 429) return { ok: false, reason: 'rate-limited' };
  if (!res.ok) return { ok: false, reason: 'unexpected', detail: `HTTP ${res.status}` };

  try {
    const d: any = await res.json();
    const usage: PlanUsage = {
      fiveHour: toWindow(d.five_hour),
      sevenDay: toWindow(d.seven_day),
      sevenDayOpus: toWindow(d.seven_day_opus),
      sevenDaySonnet: toWindow(d.seven_day_sonnet),
      fetchedAt: new Date(),
    };
    const x = d.extra_usage;
    if (x?.is_enabled && typeof x.monthly_limit === 'number') {
      const scale = 10 ** (x.decimal_places ?? 2);
      usage.extra = {
        used: (x.used_credits ?? 0) / scale,
        limit: x.monthly_limit / scale,
        currency: x.currency ?? 'USD',
        percent: x.utilization ?? 0,
      };
    }
    if (!usage.fiveHour && !usage.sevenDay) return { ok: false, reason: 'unexpected', detail: 'no limits in response' };
    return { ok: true, usage };
  } catch (e) {
    return { ok: false, reason: 'unexpected', detail: String(e) };
  }
}
