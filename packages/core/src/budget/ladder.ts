/**
 * The downgrade ladder (design 7.6). When a proposed panel would exceed a ceiling and
 * `budget.onOverBudget` is "downgrade-then-block", steps are tried in order, stopping as soon as the panel fits:
 *   1. hunters-model  every hunter one model tier down
 *   2. judges-model   every judge one tier down, never below the hunters' tier
 *   3. seat-count     drop hunter seats down to the quorum minimum, keeping the lenses listed first
 *   4. block          still over budget
 * With `onOverBudget: "block"` it goes straight to block. Every applied step is returned so the verdict can record
 * that a cheaper review ran; downgraded seats carry `downgradedFrom` (the original model, kept across steps).
 *
 * Model knowledge is injected (`cheaper`, `estimate`, optional `tierOf`) because core cannot depend on the registry.
 */
import type { Policy } from "../policy/schema.js";
import type { DowngradeStep, LensId, ModelRef, ModelTierClass, Seat } from "../types.js";
import { formatUsd as usd } from "./format.js";

export interface DowngradeInput {
  seats: Seat[];
  policy: Policy;
  /** Estimated USD for one seat. Undefined counts as 0, so price unknown models pessimistically before calling. */
  estimate: (seat: Seat) => number | undefined;
  /** The next cheaper model on the same connection, or undefined at the bottom of the ladder. */
  cheaper: (model: ModelRef) => ModelRef | undefined;
  /** The binding limit (normally the per-change ceiling). `<= 0` means disabled: always within budget. */
  limitUsd: number;
  alreadySpentUsd: number;
  quorumRequired: number;
  /** Optional tier lookup; when given, "never below the hunters' tier" is checked by tier class. */
  tierOf?: (model: ModelRef) => ModelTierClass | undefined;
  /** Lens priority for seat dropping; defaults to the order hunters appear in `seats` (policy order from seating). */
  lensPriority?: LensId[];
}

export interface DowngradeResult {
  seats: Seat[];
  steps: DowngradeStep[];
  withinBudget: boolean;
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

export function downgradeLadder(input: DowngradeInput): DowngradeResult {
  const { estimate, cheaper, alreadySpentUsd } = input;
  const limit = input.limitUsd;
  const total = (seats: Seat[]): number =>
    alreadySpentUsd + seats.reduce((sum, s) => sum + Math.max(0, estimate(s) ?? 0), 0);
  const fits = (seats: Seat[]): boolean => !(limit > 0) || total(seats) <= limit + 1e-9;
  const over = (seats: Seat[]): string =>
    `estimate ${usd(total(seats) - alreadySpentUsd)} + ${usd(alreadySpentUsd)} spent exceeds the ${usd(limit)} limit`;

  let seats = input.seats;
  const steps: DowngradeStep[] = [];
  if (fits(seats)) return { seats, steps, withinBudget: true };

  const block = (): DowngradeResult => {
    steps.push({
      step: "block",
      reason: `Still over budget: ${over(seats)}. Raise budget.perChangeUsd (or set budget.onOverBudget) and re-run.`,
    });
    return { seats, steps, withinBudget: false };
  };

  if (input.policy.budget.onOverBudget === "block") return block();

  // 1. Hunters one tier down.
  {
    const before = seats.filter((s) => s.role === "hunter").map((s) => s.model);
    const reason = over(seats);
    let changed = false;
    const next = seats.map((s) => {
      if (s.role !== "hunter") return s;
      const c = cheaper(s.model);
      if (!c || sameModel(c, s.model)) return s;
      changed = true;
      return stepDown(s, c);
    });
    if (changed) {
      seats = next;
      const after = seats.filter((s) => s.role === "hunter").map((s) => s.model);
      steps.push({ step: "hunters-model", from: distinct(before), to: distinct(after), reason });
      if (fits(seats)) return { seats, steps, withinBudget: true };
    }
  }

  // 2. Judges one tier down, never below the hunters.
  {
    const hunters = seats.filter((s) => s.role === "hunter").map((s) => s.model);
    const hunterRank = input.tierOf ? maxRank(hunters, input.tierOf) : undefined;
    const before = seats.filter((s) => s.role === "judge").map((s) => s.model);
    const reason = over(seats);
    let changed = false;
    const next = seats.map((s) => {
      if (s.role !== "judge") return s;
      const c = cheaper(s.model);
      if (!c || sameModel(c, s.model)) return s;
      if (!judgeMayStep(s.model, c, hunters, hunterRank, input)) return s;
      changed = true;
      return stepDown(s, c);
    });
    if (changed) {
      seats = next;
      const after = seats.filter((s) => s.role === "judge").map((s) => s.model);
      steps.push({ step: "judges-model", from: distinct(before), to: distinct(after), reason });
      if (fits(seats)) return { seats, steps, withinBudget: true };
    }
  }

  // 3. Drop hunters down to the quorum minimum, lowest-priority lenses first.
  {
    const minHunters = Math.max(1, input.quorumRequired);
    const hunters = seats.filter((s) => s.role === "hunter");
    if (hunters.length > minHunters) {
      const priority = (s: Seat): number => {
        const i = input.lensPriority?.indexOf(s.lens) ?? -1;
        return i >= 0 ? i : (input.lensPriority?.length ?? 0) + hunters.indexOf(s);
      };
      const ranked = [...hunters].sort((a, b) => priority(a) - priority(b));
      const reason = over(seats);
      const dropped = new Set<string>();
      let current = seats;
      while (ranked.length > minHunters && !fits(current)) {
        const drop = ranked.pop() as Seat;
        dropped.add(drop.id);
        current = current.filter((s) => s.id !== drop.id);
      }
      seats = current;
      steps.push({
        step: "seat-count",
        from: `${hunters.length} hunters`,
        to: `${hunters.length - dropped.size} hunters`,
        reason: `${reason}; dropped ${[...dropped].join(", ")}`,
      });
      if (fits(seats)) return { seats, steps, withinBudget: true };
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

function judgeMayStep(
  current: ModelRef,
  next: ModelRef,
  hunters: ModelRef[],
  hunterRank: number | undefined,
  input: DowngradeInput,
): boolean {
  if (input.tierOf && hunterRank !== undefined) {
    const t = input.tierOf(next);
    if (t !== undefined) return RANK[t] >= hunterRank;
  }
  // No tier info: refuse when the judge already sits on a hunter's model; otherwise one step is at worst level.
  return !hunters.some((h) => sameModel(h, current));
}
