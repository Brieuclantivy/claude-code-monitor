import * as vscode from 'vscode';

const locale = () => vscode.env.language || 'en';

export function tokens(n: number): string {
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function usd(n: number): string {
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
}

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function percent(n: number): string {
  return `${Math.round(n)}%`;
}

/** Compact duration: "45 s", "12 min", "2 h 05", "3 d 4 h" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return vscode.l10n.t('{0} d {1} h', Math.floor(h / 24), h % 24);
}

export function clockTime(d: Date): string {
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale(), sameDay ? { timeStyle: 'short' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Escapes text for use inside a MarkdownString (tooltips). */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!|<>~])/g, '\\$1');
}
