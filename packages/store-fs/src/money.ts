import type { CostEntry, SpendSummary, TokenUsage } from "@merge-safely/core";

/** Integer micro-dollars per dollar. Sums are done on integers so 0.1 + 0.2 comes out as exactly 0.3. */
export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) throw new Error("cost entry usd must be a finite number");
  return Math.round(usd * MICROS_PER_USD);
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

export function subtractTotals(a: Totals, b: Totals): Totals {
  return {
    usdMicros: a.usdMicros - b.usdMicros,
    in: a.in - b.in,
    out: a.out - b.out,
    cachedIn: a.cachedIn - b.cachedIn,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    entries: a.entries - b.entries,
  };
}

export function toSummary(t: Totals): SpendSummary {
  return {
    usd: t.usdMicros / MICROS_PER_USD,
    tokens: { in: t.in, out: t.out, cachedIn: t.cachedIn, cacheWrite: t.cacheWrite },
    entries: t.entries,
  };
}

export function sameRepo(a: CostEntry["repo"], b: CostEntry["repo"]): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.owner === b.owner && a.name === b.name;
}

/** True when `atMs` falls inside the rolling window (now - windowMs, now]. */
export function inWindow(atMs: number, nowMs: number, windowMs: number): boolean {
  return atMs > nowMs - windowMs && atMs <= nowMs;
}
