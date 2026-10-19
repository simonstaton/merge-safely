/** Budget admission for a seated panel (design 4.2 step 5, 7.6), over the injected pricing and the cost ledger. */
import {
  admit,
  bindingCeiling,
  CEILING_POLICY_KEYS,
  type CeilingInput,
  type CeilingKind,
  type CeilingResult,
  ceilingMessage,
  effectiveCeilingLimit,
  isInstallationCeiling,
} from "../budget/ceilings.js";
import { ceilingEvaluator, downgradeLadder } from "../budget/ladder.js";
import { estimatePanel } from "../budget/seat-budget.js";
import { findInCatalog } from "../panel/seating.js";
import { requiredPasses } from "../stages/aggregate.js";
import type { Change, DowngradeStep, ModelRef, ModelTierClass, Seat, Tier } from "../types.js";
import { catalogOf, type Env, modelInfoFor, safeText } from "./env.js";
import { estimateSeatUsage } from "./util.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The monthly ceiling is evaluated over a rolling 30 days (the ledger port has no calendar query). */
export const MONTH_MS = 30 * DAY_MS;

export type SpendInputs = Omit<CeilingInput, "policy" | "seatEstimates" | "advisory">;

export function scopeIdFor(env: Env, change: Change): string {
  return env.deps.installationId ?? `${change.repo.host}/${change.repo.owner}/${change.repo.name}`;
}

/**
 * Spend so far from the ledger. Without a ledger, per-change spend is taken as 0 (only this panel is known) and the
 * installation-wide inputs are undefined, so configured installation ceilings fail closed. A ledger call that throws
 * yields NaN / undefined for that input, which also fails closed.
 */
export async function spendInputs(env: Env, change: Change, scopeId: string): Promise<SpendInputs> {
  const ledger = env.deps.ledger;
  if (!ledger) return { changeSpendUsd: 0 };
  const b = env.policy.budget;
  const read = async (what: string, fn: () => Promise<{ usd: number }>): Promise<number | undefined> => {
    try {
      return (await fn()).usd;
    } catch (err: unknown) {
      env.logger.error("cost ledger read failed; failing closed", { what, error: safeText(env, err) });
      return undefined;
    }
  };
  const out: SpendInputs = {
    changeSpendUsd: (await read("forChange", () => ledger.forChange(change.repo, change.number))) ?? Number.NaN,
  };
  if (effectiveCeilingLimit(b.windowUsd) !== null) {
    const v = await read("forWindow", () => ledger.forWindow(scopeId, b.windowDays * DAY_MS));
    if (v !== undefined) out.windowSpendUsd = v;
  }
  if (effectiveCeilingLimit(b.spendLimitUsd) !== null) {
    const v = await read("allTime", () => ledger.allTime(scopeId));
    if (v !== undefined) out.allTimeSpendUsd = v;
  }
  if (effectiveCeilingLimit(b.perInstallationMonthlyUsd) !== null) {
    const v = await read("monthly", () => ledger.forWindow(scopeId, MONTH_MS));
    if (v !== undefined) out.monthlySpendUsd = v;
  }
  return out;
}

/** Per-seat dollar estimate: injected (or heuristic) usage priced with the injected pricing. */
export function seatEstimator(
  env: Env,
  change: Change,
  diffChars: number,
  secondJudgeRound: boolean,
): (seat: Seat) => number | undefined {
  const estimateUsage = env.deps.estimateUsage ?? estimateSeatUsage;
  return (seat) => {
    try {
      const usage = estimateUsage(seat, { diffChars, change, secondJudgeRound });
      const usd = env.deps.pricing.price(modelInfoFor(env, seat.model), usage).usd;
      return Number.isFinite(usd) ? usd : undefined;
    } catch (err: unknown) {
      env.logger.warn("seat estimate failed", { seatId: seat.id, error: safeText(env, err) });
      return undefined;
    }
  };
}

export type BudgetPlan =
  | {
      ok: true;
      seats: Seat[];
      downgrades: DowngradeStep[];
      results: CeilingResult[];
      estimateUsd?: number;
      unknownSeats: string[];
    }
  | {
      ok: false;
      binding: CeilingResult;
      message: string;
      downgrades: DowngradeStep[];
      results: CeilingResult[];
      estimateUsd?: number;
    };

export function tierOfRef(env: Env, ref: ModelRef): ModelTierClass | undefined {
  return findInCatalog(catalogOf(env, ref.connectionId), ref.name, { normalise: env.normalise })?.tier;
}

/**
 * Admit the panel, or run the downgrade ladder, or refuse. Installation-wide ceilings (window, all-time, monthly)
 * refuse outright: a cheaper panel does not help the next PR. `onOverBudget: "block"` also refuses outright.
 */
export function planBudget(
  env: Env,
  args: { seats: Seat[]; tier: Tier; spend: SpendInputs; estimate: (seat: Seat) => number | undefined },
): BudgetPlan {
  const { policy } = env;
  const advisory: CeilingKind[] = env.deps.advisoryCeilings ?? [];
  const base = { policy, ...args.spend, advisory };
  const evaluate = ceilingEvaluator(base, args.estimate);
  const panel = (seats: Seat[]) => estimatePanel(seats, args.estimate);

  const seatEstimates = args.seats.map((s) => {
    const usd = args.estimate(s);
    return usd === undefined ? { seatId: s.id } : { seatId: s.id, usd };
  });
  const admission = admit({ ...base, seatEstimates });
  for (const r of admission.advisoryBreaches) {
    env.logger.warn("advisory budget ceiling exceeded", { ceiling: r.ceiling, projectedUsd: r.projectedUsd });
  }
  if (admission.ok) {
    const est = panel(args.seats);
    return {
      ok: true,
      seats: args.seats,
      downgrades: [],
      results: admission.results,
      estimateUsd: est.usd,
      unknownSeats: est.unknownSeats,
    };
  }
  const refuse = (binding: CeilingResult, results: CeilingResult[], downgrades: DowngradeStep[]): BudgetPlan => {
    const est = panel(args.seats);
    const plan: BudgetPlan = { ok: false, binding, message: ceilingMessage(binding, policy), downgrades, results };
    if (est.usd !== undefined) plan.estimateUsd = est.usd;
    return plan;
  };
  if (isInstallationCeiling(admission.binding.ceiling) || policy.budget.onOverBudget === "block") {
    return refuse(admission.binding, admission.results, []);
  }
  const ladder = downgradeLadder({
    seats: args.seats,
    policy,
    evaluate,
    cheaper: (ref) => {
      try {
        return env.deps.pricing.cheaper(ref, catalogOf(env, ref.connectionId));
      } catch (err: unknown) {
        env.logger.warn("cheaper-model lookup failed", { model: ref.name, error: safeText(env, err) });
        return undefined;
      }
    },
    tierOf: (ref) => tierOfRef(env, ref),
    quorumRequired: requiredPasses(args.tier.level, policy),
  });
  if (ladder.withinBudget) {
    const est = panel(ladder.seats);
    return {
      ok: true,
      seats: ladder.seats,
      downgrades: ladder.steps,
      results: ladder.results,
      estimateUsd: est.usd,
      unknownSeats: est.unknownSeats,
    };
  }
  const binding = bindingCeiling(ladder.results) ?? admission.binding;
  return refuse(binding, ladder.results, ladder.steps);
}

/** "budget.perChangeUsd" -> "perChangeUsd", the name the budget-blocked digest prefixes with "budget.". */
export function ceilingPolicyName(kind: CeilingKind): string {
  return CEILING_POLICY_KEYS[kind].replace(/^budget\./, "");
}
