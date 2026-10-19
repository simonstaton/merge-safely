/**
 * The downgrade ladder (design 7.6). When a proposed panel breaches any ceiling and
 * `budget.onOverBudget` is "downgrade-then-block", steps are tried in order, re-evaluating every ceiling after
 * each one and stopping as soon as nothing blocks:
 *   1. hunters-model  every hunter one model tier down
 *   2. judges-model   every judge one tier down, never below the hunters' tier
 *   3. seat-count     drop hunter seats down to the quorum minimum, lowest-priority lenses first
 *   4. block          still over budget; the reason names the binding ceiling and its policy key
 * With `onOverBudget: "block"` it goes straight to block. Every applied step is returned so the verdict can record
 * that a cheaper review ran; downgraded seats carry `downgradedFrom` (the original model, kept across steps).
 *
 * Model knowledge is injected (`cheaper`, `tierOf`) and so is ceiling evaluation (`evaluate`, usually built with
 * `ceilingEvaluator`) because core cannot depend on the registry.
 */
import type { Policy } from "../policy/schema.js";
import type { DowngradeStep, LensId, ModelRef, ModelTierClass, Seat } from "../types.js";
import {
  admitResults,
  CEILING_POLICY_KEYS,
  type CeilingInput,
  type CeilingResult,
  evaluateCeilings,
} from "./ceilings.js";
import { formatUsd as usd } from "./format.js";

/** Lenses kept longest when cutting hunters to quorum (dropped from the end). Unlisted lenses are dropped first. */
export const DEFAULT_LENS_PRIORITY: readonly LensId[] = [
  "correctness",
  "security",
  "intent",
  "rollout",
  "repro",
  "perf",
  "blast-radius",
  "design-fidelity",
];

export interface DowngradeInput {
  seats: Seat[];
  policy: Policy;
  /** Evaluate every ceiling for a candidate panel. Advisory ceilings in the results never block. */
  evaluate: (seats: Seat[]) => CeilingResult[];
  /** The next cheaper model on the same connection, or undefined at the bottom of the ladder. */
  cheaper: (model: ModelRef) => ModelRef | undefined;
  /** Tier of a model; a judge step to a model of unknown tier is refused. */
  tierOf: (model: ModelRef) => ModelTierClass | undefined;
  quorumRequired: number;
  /** Lens keep-priority for seat dropping; defaults to DEFAULT_LENS_PRIORITY. */
  lensPriority?: readonly LensId[];
}

export interface DowngradeResult {
  seats: Seat[];
  steps: DowngradeStep[];
  withinBudget: boolean;
  /** Ceiling results for the returned seats. */
  results: CeilingResult[];
}

/**
 * Build an `evaluate` callback from the spend inputs and a per-seat estimator. Undefined estimates count as $0,
 * so price unknown models pessimistically (registry `withPricing`) before estimating.
 */
export function ceilingEvaluator(
  base: Omit<CeilingInput, "seatEstimates">,
  estimate: (seat: Seat) => number | undefined,
): (seats: Seat[]) => CeilingResult[] {
  return (seats) => {
    const seatEstimates = seats.map((s) => {
      const e = estimate(s);
      return e === undefined ? { seatId: s.id } : { seatId: s.id, usd: e };
    });
    return evaluateCeilings({ ...base, seatEstimates });
  };
}

const RANK: Record<ModelTierClass, number> = { small: 0, mid: 1, frontier: 2 };

function refKey(m: ModelRef): string {
  return `${m.connectionId}/${m.name}`;
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.connectionId === b.connectionId && a.name === b.name;
}

function distinct(models: ModelRef[]): string {
  return [...new Set(models.map(refKey))].join(", ");
}

function stepDown(s: Seat, to: ModelRef): Seat {
  return { ...s, model: to, downgradedFrom: s.downgradedFrom ?? s.model };
}

function summary(r: CeilingResult): string {
  if (r.unknownSpend) return `spend for ${r.ceiling} unknown (${CEILING_POLICY_KEYS[r.ceiling]})`;
  const who = r.seatId ? ` (${r.seatId})` : "";
  return `"${r.ceiling}"${who} projected ${usd(r.projectedUsd)} exceeds ${usd(r.limitUsd ?? 0)} (${CEILING_POLICY_KEYS[r.ceiling]})`;
}

export function downgradeLadder(input: DowngradeInput): DowngradeResult {
  const { cheaper, tierOf, policy } = input;
  let seats = input.seats;
  let results = input.evaluate(seats);
  const steps: DowngradeStep[] = [];
  const check = (): ReturnType<typeof admitResults> => admitResults(results, policy);

  let admission = check();
  if (admission.ok) return { seats, steps, withinBudget: true, results };

  const block = (): DowngradeResult => {
    const a = check();
    const reason = a.ok ? "Over budget." : `Still over budget. ${a.message}`;
    steps.push({ step: "block", reason });
    return { seats, steps, withinBudget: false, results };
  };
  const apply = (next: Seat[], step: DowngradeStep): boolean => {
    seats = next;
    steps.push(step);
    results = input.evaluate(seats);
    admission = check();
    return admission.ok;
  };

  if (policy.budget.onOverBudget === "block") return block();

  // 1. Hunters one tier down.
  {
    const before = seats.filter((s) => s.role === "hunter").map((s) => s.model);
    let changed = false;
    const next = seats.map((s) => {
      if (s.role !== "hunter") return s;
      const c = cheaper(s.model);
      if (!c || sameModel(c, s.model)) return s;
      changed = true;
      return stepDown(s, c);
    });
    if (changed && !admission.ok) {
      const reason = summary(admission.binding);
      const after = next.filter((s) => s.role === "hunter").map((s) => s.model);
      if (apply(next, { step: "hunters-model", from: distinct(before), to: distinct(after), reason })) {
        return { seats, steps, withinBudget: true, results };
      }
    }
  }

  // 2. Judges one tier down, never below the hunters.
  {
    const hunterRank = maxRank(
      seats.filter((s) => s.role === "hunter").map((s) => s.model),
      tierOf,
    );
    const before = seats.filter((s) => s.role === "judge").map((s) => s.model);
    let changed = false;
    const next = seats.map((s) => {
      if (s.role !== "judge") return s;
      const c = cheaper(s.model);
      if (!c || sameModel(c, s.model)) return s;
      const t = tierOf(c);
      if (t === undefined || hunterRank === undefined || RANK[t] < hunterRank) return s;
      changed = true;
      return stepDown(s, c);
    });
    if (changed && !admission.ok) {
      const reason = summary(admission.binding);
      const after = next.filter((s) => s.role === "judge").map((s) => s.model);
      if (apply(next, { step: "judges-model", from: distinct(before), to: distinct(after), reason })) {
        return { seats, steps, withinBudget: true, results };
      }
    }
  }

  // 3. Drop hunters down to the quorum minimum, lowest-priority lenses first.
  {
    const minHunters = Math.max(1, input.quorumRequired);
    const hunters = seats.filter((s) => s.role === "hunter");
    if (hunters.length > minHunters && !admission.ok) {
      const order = input.lensPriority ?? DEFAULT_LENS_PRIORITY;
      const priority = (s: Seat): number => {
        const i = order.indexOf(s.lens);
        // Unlisted lenses rank below every listed one, in seat order.
        return i >= 0 ? i : order.length + hunters.indexOf(s);
      };
      const ranked = [...hunters].sort((a, b) => priority(a) - priority(b));
      const reason = summary(admission.binding);
      const dropped: string[] = [];
      let current = seats;
      let currentResults = results;
      while (ranked.length > minHunters && !admitResults(currentResults, policy).ok) {
        const drop = ranked.pop() as Seat;
        dropped.push(drop.id);
        current = current.filter((s) => s.id !== drop.id);
        currentResults = input.evaluate(current);
      }
      const step: DowngradeStep = {
        step: "seat-count",
        from: `${hunters.length} hunters`,
        to: `${hunters.length - dropped.length} hunters`,
        reason: `${reason}; dropped ${dropped.join(", ")}`,
      };
      if (apply(current, step)) return { seats, steps, withinBudget: true, results };
    }
  }

  return block();
}

function maxRank(models: ModelRef[], tierOf: (m: ModelRef) => ModelTierClass | undefined): number | undefined {
  let r: number | undefined;
  for (const m of models) {
    const t = tierOf(m);
    if (t !== undefined) r = Math.max(r ?? -1, RANK[t]);
  }
  return r;
}
