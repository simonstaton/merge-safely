/**
 * Setup-page estimate: what one review of a typical 300-line PR costs per tier on a given model, using the default
 * policy's panels and registry pricing. Deliberately rough and on the high side; the gate's own `estimate` (and the
 * ledger) are the real numbers.
 */
import { DEFAULT_POLICY, type ModelInfo, type Policy, type TokenUsage } from "@merge-safely/core";
import { priceUsage, withPricing } from "@merge-safely/registry";

/** A 300-line diff is ~12k chars, ~3k tokens; agentic seats re-read it and the files around it over many turns. */
export const TYPICAL_PR_LINES = 300;
export const HUNTER_USAGE: TokenUsage = { in: 60_000, out: 4_000 };
export const JUDGE_USAGE: TokenUsage = { in: 45_000, out: 3_000 };

export interface TierEstimate {
  tier: 1 | 2 | 3;
  hunters: number;
  judges: number;
  usd: number;
  /** True when the model has no known pricing and the pessimistic fallback was used. */
  estimated: boolean;
  zeroCost: boolean;
}

export function estimateTiers(model: ModelInfo, policy: Policy = DEFAULT_POLICY): TierEstimate[] {
  const priced = withPricing(model);
  const hunterCost = priceUsage(priced, HUNTER_USAGE);
  const judgeCost = priceUsage(priced, JUDGE_USAGE);
  const tiers = [
    { tier: 1 as const, p: policy.panel.t1 },
    { tier: 2 as const, p: policy.panel.t2 },
    { tier: 3 as const, p: policy.panel.t3 },
  ];
  return tiers.map(({ tier, p }) => {
    const judges = p.judges * (p.secondJudgeRound ? 2 : 1);
    return {
      tier,
      hunters: p.hunters.length,
      judges,
      usd: p.hunters.length * hunterCost.usd + judges * judgeCost.usd,
      estimated: hunterCost.estimated || (priced.source ?? "").endsWith(":pessimistic"),
      zeroCost: priced.zeroCost === true,
    };
  });
}

/** Pick the model to estimate with: the connection's default model when reachable, else the strongest mid tier. */
export function pickEstimateModel(models: ModelInfo[], defaultModel?: string): ModelInfo | undefined {
  if (defaultModel) {
    const hit = models.find((m) => m.name === defaultModel);
    if (hit) return hit;
  }
  return models.find((m) => m.tier === "mid") ?? models.find((m) => m.tier === "frontier") ?? models[0];
}
