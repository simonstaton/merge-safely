import type { SpendSummary } from "@merge-safely/core";

/** Integer micro-dollars per dollar. usd is stored and summed as integers so totals are exact. */
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
