import type {
  CostEntry,
  CostLedger,
  RepoRef,
  SpendSummary,
  Verdict,
  VerdictKey,
  VerdictStore,
} from "@merge-safely/core";
import { changeKeyString, verdictKeyString } from "./key.js";
import {
  addEntry,
  inWindow,
  sameRepo,
  subtractTotals,
  type Totals,
  toSummary,
  usdToMicros,
  zeroTotals,
} from "./money.js";

interface Slot {
  verdict: Verdict;
  version: string;
  seq: number;
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
      const current = slots.get(k);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== expect.version) return { ok: false, version: currentVersion ?? "" };
      counter += 1;
      const version = `m${counter}`;
      slots.set(k, { verdict: structuredClone(v), version, seq: counter });
      return { ok: true, version };
    },

    async listForChange(repo: RepoRef, number: number) {
      const prefix = `${changeKeyString(repo, number)}@`;
      const found: Slot[] = [];
      for (const [k, slot] of slots) if (k.startsWith(prefix)) found.push(slot);
      return sortByCreatedAt(found).map((s) => structuredClone(s.verdict));
    },
  };
}

function sortByCreatedAt(slots: Slot[]): Slot[] {
  return slots.sort((a, b) => {
    const d = createdAtMs(a.verdict) - createdAtMs(b.verdict);
    return d !== 0 ? d : a.seq - b.seq;
  });
}

function createdAtMs(v: Verdict): number {
  const t = Date.parse(v.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

interface Row {
  entry: CostEntry;
  usdMicros: number;
  /** Parsed `at`; an unparseable timestamp is recorded at append time so spend never vanishes. */
  atMs: number;
}

/**
 * In-memory CostLedger. usd is held as integer micro-dollars so sums are exact.
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
      const parsed = Date.parse(entry.at);
      rows.push({
        entry: structuredClone(entry),
        usdMicros: usdToMicros(entry.usd),
        atMs: Number.isNaN(parsed) ? now().getTime() : parsed,
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
      const base = baselines.get(installationId) ?? zeroTotals();
      return toSummary(subtractTotals(rawAllTime(installationId), base));
    },

    async reset(installationId: string) {
      baselines.set(installationId, rawAllTime(installationId));
    },
  };
}
