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
import type { Change, DowngradeStep, ModelRef, ModelTierClass, Seat, Tier, Verdict } from "../types.js";
import { catalogOf, type Env, modelInfoFor, safeText, withTimeout } from "./env.js";
import type { UsageEstimateContext } from "./types.js";
import { diffExceedsContext, estimateSeatUsage } from "./util.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The monthly ceiling is evaluated over a rolling 30 days (the ledger port has no calendar query). */
export const MONTH_MS = 30 * DAY_MS;

export type SpendInputs = Omit<CeilingInput, "policy" | "seatEstimates" | "advisory">;

export function scopeIdFor(env: Env, change: Change): string {
  return env.deps.installationId ?? `${change.repo.host}/${change.repo.owner}/${change.repo.name}`;
}

/** Spend recorded on the change's stored verdicts (one per SHA, so an overwritten round's cost is not counted). */
export function priorVerdictSpend(prior: Verdict[], change: Change): number {
  let usd = 0;
  for (const v of prior) {
    if (v.number !== change.number || v.repo.owner !== change.repo.owner || v.repo.name !== change.repo.name) continue;
    if (v.repo.host !== change.repo.host) continue;
    const c = v.cost?.usd;
    if (typeof c === "number" && Number.isFinite(c) && c > 0) usd += c;
  }
  return usd;
}

/**
 * Spend so far. Per-change spend is the larger of the ledger figure and the sum of `cost.usd` over the change's
 * stored verdicts (so a ledger-less deployment still enforces "one PR across all rounds"). Without a ledger the
 * installation-wide inputs are undefined, so configured installation ceilings fail closed. A ledger read that throws
 * or times out yields NaN / undefined for that input, which also fails closed.
 */
export async function spendInputs(env: Env, change: Change, scopeId: string, prior: Verdict[]): Promise<SpendInputs> {
  const fromVerdicts = priorVerdictSpend(prior, change);
  const ledger = env.deps.ledger;
  if (!ledger) return { changeSpendUsd: fromVerdicts };
  const b = env.policy.budget;
  const read = async (what: string, fn: () => Promise<{ usd: number }>): Promise<number | undefined> => {
    try {
      const r = await withTimeout(Promise.resolve().then(fn), env.timeouts.ledgerReadMs, `cost ledger ${what}`);
      return typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : undefined;
    } catch (err: unknown) {
      env.logger.error("cost ledger read failed; failing closed", { what, error: safeText(env, err) });
      return undefined;
    }
  };
  const ledgerChange = await read("forChange", () => ledger.forChange(change.repo, change.number));
  const out: SpendInputs = {
    changeSpendUsd: ledgerChange === undefined ? Number.NaN : Math.max(ledgerChange, fromVerdicts),
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

/**
 * Per-seat dollar estimate: injected (or heuristic) usage priced with the injected pricing, with the seat model's
 * context window passed so the estimate is capped by it.
 */
export function seatEstimator(
  env: Env,
  change: Change,
  diffChars: number,
  secondJudgeRound: boolean,
): (seat: Seat) => number | undefined {
  const estimateUsage = env.deps.estimateUsage ?? estimateSeatUsage;
  return (seat) => {
    try {
      const info = modelInfoFor(env, seat.model);
      const ctx: UsageEstimateContext = { diffChars, change, secondJudgeRound };
      if (info.contextTokens > 0) ctx.contextTokens = info.contextTokens;
      const usd = env.deps.pricing.price(info, estimateUsage(seat, ctx)).usd;
      return Number.isFinite(usd) ? usd : undefined;
    } catch (err: unknown) {
      env.logger.warn("seat estimate failed", { seatId: seat.id, error: safeText(env, err) });
      return undefined;
    }
  };
}

/** Seats whose model cannot even hold the diff; their estimate is capped and so is not trustworthy. */
export function overContextSeats(env: Env, seats: Seat[], diffChars: number): string[] {
  return seats.filter((s) => diffExceedsContext(diffChars, modelInfoFor(env, s.model).contextTokens)).map((s) => s.id);
}

/**
 * Whether a fallback attempt fits the per-change ceiling: spend so far, plus the admitted panel estimate with this
 * seat's own estimate swapped for what its failed attempt actually cost plus the fallback's estimate.
 */
export function fallbackFits(
  env: Env,
  args: {
    spend: SpendInputs;
    panelUsd: number | undefined;
    estimate: (seat: Seat) => number | undefined;
    original: Seat;
    fallback: Seat;
    spentUsd: number;
  },
): boolean {
  const limit = effectiveCeilingLimit(env.policy.budget.perChangeUsd);
  if (limit === null) return true;
  const fb = args.estimate(args.fallback);
  if (fb === undefined) return false;
  const projected =
    args.spend.changeSpendUsd + (args.panelUsd ?? 0) - (args.estimate(args.original) ?? 0) + args.spentUsd + fb;
  return Number.isFinite(projected) && projected <= limit + 1e-9;
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
