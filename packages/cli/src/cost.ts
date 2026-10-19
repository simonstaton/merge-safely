/**
 * "What will this cost?" before anything runs (design 7.4): for a connection's reachable models, the models each
 * tier would seat and the estimated dollars for a typical PR, priced from the registry.
 *
 * Tokens per seat come from the core's `estimateSeatUsage`, the same heuristic `estimate` and the budget ceilings
 * use, so the number `connect` shows matches what admission will check. Real spend is streamed into the ledger.
 */
import {
  type Change,
  DEFAULT_POLICY,
  estimateSeatUsage,
  type ModelInfo,
  type Policy,
  type Seat,
  seatBudgetFromPolicy,
  sortByTier,
  type TokenUsage,
} from "@merge-safely/core";
import { priceUsage, withPricing } from "@merge-safely/registry";

export const TYPICAL_PR_LINES = 300;

/** Files a typical PR touches, for the diff-size estimate. */
const TYPICAL_FILES = 8;

function typicalChange(lines: number): Change {
  const half = Math.round(lines / 2);
  return {
    repo: { host: "github.com", owner: "example", name: "example" },
    number: 0,
    headSha: "",
    baseSha: "",
    baseRef: "main",
    headRef: "feature",
    title: "",
    body: "",
    author: { kind: "human", login: "example" },
    files: [],
    stats: { additions: half, deletions: lines - half, files: TYPICAL_FILES },
    labels: [],
    draft: false,
    ciStatus: "unknown",
  };
}

/** Estimated tokens for one seat reviewing a diff of `lines` changed lines (core `estimateSeatUsage`). */
export function seatTokens(
  role: "hunter" | "judge",
  lines: number,
  policy: Policy = DEFAULT_POLICY,
  secondJudgeRound = false,
  contextTokens?: number,
): TokenUsage {
  const l = Math.max(0, lines);
  const seat: Seat = {
    id: `${role}:typical`,
    lens: role === "judge" ? "judge" : "correctness",
    role,
    model: { connectionId: "", provider: "", name: "" },
    budget: seatBudgetFromPolicy(policy, role),
  };
  return estimateSeatUsage(seat, {
    diffChars: l * 60 + TYPICAL_FILES * 150,
    change: typicalChange(l),
    secondJudgeRound,
    ...(contextTokens ? { contextTokens } : {}),
  });
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
    const judges = p.judges;
    const h = seatUsd(hunter, seatTokens("hunter", lines, policy, false, hunter?.contextTokens));
    const j = seatUsd(judge, seatTokens("judge", lines, policy, p.secondJudgeRound, judge?.contextTokens));
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
