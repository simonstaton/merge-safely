/**
 * "What will this cost?" before anything runs (design 7.4): for a connection's reachable models, the models each
 * tier would seat and the estimated dollars for a typical PR, priced from the registry.
 *
 * The token model is a deliberately rough, pessimistic heuristic (no prompt caching assumed): an agentic seat
 * re-sends its growing context every turn, so input dominates. Real spend is streamed into the ledger and
 * enforced by the budget ceilings; this is only for setting expectations.
 */
import { DEFAULT_POLICY, type ModelInfo, type Policy, sortByTier, type TokenUsage } from "@merge-safely/core";
import { priceUsage, withPricing } from "@merge-safely/registry";

export const TYPICAL_PR_LINES = 300;

/** Estimated tokens for one seat reviewing a diff of `lines` changed lines. */
export function seatTokens(role: "hunter" | "judge", lines: number): TokenUsage {
  const l = Math.max(0, lines);
  return role === "hunter" ? { in: 150_000 + l * 100, out: 6_000 } : { in: 60_000 + l * 40, out: 3_000 };
}

export interface TierCost {
  tier: 1 | 2 | 3;
  hunters: number;
  judges: number;
  hunterModel?: ModelInfo;
  judgeModel?: ModelInfo;
  usd: number;
  /** True when a model had no registry pricing and the pessimistic fallback rate was used. */
  pessimistic: boolean;
}

const HUNTER_PREF: ModelInfo["tier"][] = ["mid", "frontier", "small"];

/** The model seating would pick automatically: hunters the first mid model, judges the strongest. */
export function autoModels(models: ModelInfo[]): { hunter?: ModelInfo; judge?: ModelInfo } {
  const sorted = sortByTier(models);
  let hunter: ModelInfo | undefined;
  for (const t of HUNTER_PREF) {
    hunter = sorted.find((m) => m.tier === t);
    if (hunter) break;
  }
  return { hunter, judge: sorted[0] };
}

function seatUsd(model: ModelInfo | undefined, usage: TokenUsage): { usd: number; pessimistic: boolean } {
  if (!model) return { usd: 0, pessimistic: false };
  const priced = withPricing(model);
  const r = priceUsage(priced, usage);
  return { usd: r.usd, pessimistic: model.pricing === undefined && !priced.zeroCost };
}

/** Estimated cost per tier for a typical PR on one connection's models. */
export function tierCosts(models: ModelInfo[], policy: Policy = DEFAULT_POLICY, lines = TYPICAL_PR_LINES): TierCost[] {
  const { hunter, judge } = autoModels(models);
  return ([1, 2, 3] as const).map((tier) => {
    const p = policy.panel[`t${tier}`];
    const hunters = p.hunters.length;
    const judges = p.judges * (p.secondJudgeRound && p.judges > 0 ? 2 : 1);
    const h = seatUsd(hunter, seatTokens("hunter", lines));
    const j = seatUsd(judge, seatTokens("judge", lines));
    return {
      tier,
      hunters,
      judges,
      ...(hunter ? { hunterModel: hunter } : {}),
      ...(judge ? { judgeModel: judge } : {}),
      usd: h.usd * hunters + j.usd * judges,
      pessimistic: h.pessimistic || j.pessimistic,
    };
  });
}
