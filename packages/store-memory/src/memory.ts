import type {
  CostEntry,
  CostLedger,
  RepoRef,
  SpendSummary,
  Verdict,
  VerdictKey,
  VerdictStore,
} from "@merge-safely/core";
import { changeKeyString, compareVerdicts, sameRepo, verdictKeyString } from "./key.js";
import {
  addEntry,
  combine,
  entryAtMs,
  inWindow,
  type Totals,
  toSummary,
  usdToMicros,
  validateEntry,
  zeroTotals,
} from "./money.js";

interface Slot {
  verdict: Verdict;
  version: string;
}

/** In-memory VerdictStore. CAS against a process-wide monotonic version counter. Verdicts are deep-copied in and out. */
export function memoryVerdictStore(): VerdictStore {
  const slots = new Map<string, Slot>();
  let counter = 0;

  return {
    async get(key: VerdictKey) {
      const slot = slots.get(verdictKeyString(key));
      return slot ? { verdict: structuredClone(slot.verdict), version: slot.version } : null;
    },

    async put(v: Verdict, expect: { version: string | null }) {
      const k = verdictKeyString(v);
      const currentVersion = slots.get(k)?.version ?? null;
      if (currentVersion !== expect.version) return { ok: false, version: currentVersion ?? "" };
      counter += 1;
      const version = `m${counter}`;
      slots.set(k, { verdict: structuredClone(v), version });
      return { ok: true, version };
    },

    async listForChange(repo: RepoRef, number: number) {
      const prefix = `${changeKeyString(repo, number)}@`;
      const found: Verdict[] = [];
      for (const [k, slot] of slots) if (k.startsWith(prefix)) found.push(structuredClone(slot.verdict));
      return found.sort(compareVerdicts);
    },
  };
}

interface Row {
  entry: CostEntry;
  usdMicros: number;
  /** Recorded time: `at` clamped to append time when in the future or unparseable. */
  atMs: number;
}

/**
 * In-memory CostLedger. usd is held as integer micro-dollars (rounded up) so sums are exact.
 * `reset` records the current all-time totals as a baseline; allTime reports spend above it.
 * forChange and forWindow are unaffected by reset.
 */
export function memoryCostLedger(opts?: { now?: () => Date }): CostLedger {
  const now = opts?.now ?? (() => new Date());
  const rows: Row[] = [];
  const baselines = new Map<string, Totals>();

  const sum = (pred: (r: Row) => boolean): Totals => {
    const t = zeroTotals();
    for (const r of rows) if (pred(r)) addEntry(t, r.usdMicros, r.entry.tokens);
    return t;
  };
  const rawAllTime = (installationId: string) => sum((r) => r.entry.installationId === installationId);

  return {
    async append(entry: CostEntry) {
      validateEntry(entry);
      rows.push({
        entry: structuredClone(entry),
        usdMicros: usdToMicros(entry.usd),
        atMs: entryAtMs(entry.at, now().getTime()),
      });
    },

    async forChange(repo: RepoRef, number: number): Promise<SpendSummary> {
      return toSummary(sum((r) => r.entry.number === number && sameRepo(r.entry.repo, repo)));
    },

    async forWindow(installationId: string, windowMs: number): Promise<SpendSummary> {
      const nowMs = now().getTime();
      return toSummary(sum((r) => r.entry.installationId === installationId && inWindow(r.atMs, nowMs, windowMs)));
    },

    async allTime(installationId: string): Promise<SpendSummary> {
      return toSummary(combine(rawAllTime(installationId), baselines.get(installationId) ?? zeroTotals(), -1));
    },

    async reset(installationId: string) {
      baselines.set(installationId, rawAllTime(installationId));
    },
  };
}
