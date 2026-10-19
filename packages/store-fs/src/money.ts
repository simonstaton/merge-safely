// Canonical copy. store-fs and store-sqlite hold byte-identical copies; a test in each fails if they drift.
import type { CostEntry, SpendSummary, TokenUsage } from "@merge-safely/core";

/** Integer micro-dollars per dollar. Sums are done on integers so 0.1 + 0.2 comes out as exactly 0.3. */
export const MICROS_PER_USD = 1_000_000;

/**
 * Dollars to integer micro-dollars, rounding UP so the ledger can over-count but never under-count
 * (design 7.6). Float noise such as 0.1 * 1e6 = 100000.00000000001 is snapped to the nearest integer first.
 */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("cost entry usd must be a finite number >= 0");
  const m = usd * MICROS_PER_USD;
  const nearest = Math.round(m);
  const eps = Math.max(1e-6, Math.abs(m) * 1e-12);
  return Math.abs(m - nearest) <= eps ? nearest : Math.ceil(m);
}

function isCount(n: unknown): boolean {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** Reject entries that would corrupt totals. Ledger integrity matters more than tolerance, so this throws. */
export function validateEntry(e: CostEntry): void {
  usdToMicros(e.usd);
  const t = e.tokens as Partial<TokenUsage> | undefined;
  if (typeof t !== "object" || t === null) throw new Error("cost entry tokens must be an object");
  if (!isCount(t.in) || !isCount(t.out)) throw new Error("cost entry tokens.in/out must be integers >= 0");
  if (t.cachedIn !== undefined && !isCount(t.cachedIn))
    throw new Error("cost entry tokens.cachedIn must be an integer >= 0");
  if (t.cacheWrite !== undefined && !isCount(t.cacheWrite)) {
    throw new Error("cost entry tokens.cacheWrite must be an integer >= 0");
  }
  if (!isCount(e.number)) throw new Error("cost entry number must be an integer >= 0");
  if (typeof e.at !== "string") throw new Error("cost entry at must be a string");
}

/**
 * The time an entry is recorded at: its `at`, clamped to the append time when it is in the future (clock skew)
 * or unparseable, so spend is never dropped from a window.
 */
export function entryAtMs(at: string, appendNowMs: number): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? appendNowMs : Math.min(t, appendNowMs);
}

/**
 * True when `atMs` is inside the rolling window ending now. There is no upper bound: an entry ahead of the
 * reading clock counts as "now" rather than being excluded.
 */
export function inWindow(atMs: number, nowMs: number, windowMs: number): boolean {
  return atMs > nowMs - windowMs;
}

export interface Totals {
  usdMicros: number;
  in: number;
  out: number;
  cachedIn: number;
  cacheWrite: number;
  entries: number;
}

export function zeroTotals(): Totals {
  return { usdMicros: 0, in: 0, out: 0, cachedIn: 0, cacheWrite: 0, entries: 0 };
}

export function addEntry(t: Totals, usdMicros: number, tokens: TokenUsage): void {
  t.usdMicros += usdMicros;
  t.in += tokens.in;
  t.out += tokens.out;
  t.cachedIn += tokens.cachedIn ?? 0;
  t.cacheWrite += tokens.cacheWrite ?? 0;
  t.entries += 1;
}

/** a + sign * b, field by field. */
export function combine(a: Totals, b: Totals, sign: 1 | -1 = 1): Totals {
  return {
    usdMicros: a.usdMicros + sign * b.usdMicros,
    in: a.in + sign * b.in,
    out: a.out + sign * b.out,
    cachedIn: a.cachedIn + sign * b.cachedIn,
    cacheWrite: a.cacheWrite + sign * b.cacheWrite,
    entries: a.entries + sign * b.entries,
  };
}

export function toSummary(t: Totals): SpendSummary {
  return {
    usd: t.usdMicros / MICROS_PER_USD,
    tokens: { in: t.in, out: t.out, cachedIn: t.cachedIn, cacheWrite: t.cacheWrite },
    entries: t.entries,
  };
}
