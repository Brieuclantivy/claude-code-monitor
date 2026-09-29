/** Public API list prices in USD per million tokens, used for an "API-equivalent" cost estimate. */
interface Price {
  input: number;
  output: number;
  /** cache read price as a multiple of input (0.1 for most models) */
  cacheRead?: number;
}

// Ordered: first prefix match wins, so more specific ids come first.
const PRICES: [prefix: string, price: Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.025 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.025 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.05 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 15, output: 75 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
];

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export function priceFor(model: string): Price | undefined {
  return PRICES.find(([prefix]) => model.startsWith(prefix))?.[1];
}

/** Cost in USD, or undefined when the model is unknown. */
export function costOf(model: string, t: TokenCounts): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const perTok = (usdPerM: number) => usdPerM / 1_000_000;
  return (
    t.input * perTok(p.input) +
    t.output * perTok(p.output) +
    t.cacheWrite5m * perTok(p.input * 1.25) +
    t.cacheWrite1h * perTok(p.input * 2) +
    t.cacheRead * perTok(p.input * (p.cacheRead ?? 0.1))
  );
}
