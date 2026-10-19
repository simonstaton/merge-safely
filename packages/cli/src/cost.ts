/**
 * "What will this cost?" before anything runs (design 7.4): for a connection's reachable models, the models each
 * tier would seat and the estimated dollars for a typical PR, priced from the registry.
 *
 * Tokens per seat come from the core's `estimateSeatUsage`, the same heuristic `estimate` and the budget ceilings
 * use, so the number `connect` shows matches what admission will check. Real spend is streamed into the ledger.
 */
import {
  type Change,
  type ConnectionRecord,
  DEFAULT_POLICY,
  estimateSeatUsage,
  findInCatalog,
  type ModelInfo,
  type ModelRef,
  type Policy,
  type Seat,
  SeatingError,
  seat,
  seatBudgetFromPolicy,
  sortByTier,
  type Tier,
  type TokenUsage,
} from "@merge-safely/core";
import { findModel, priceUsage, withPricing } from "@merge-safely/registry";

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
  /** How the models were chosen, when it is not plain policy seating (e.g. the policy names other connections). */
  note?: string;
}

const HUNTER_PREF: ModelInfo["tier"][] = ["mid", "frontier", "small"];

/** The model seating picks automatically from a catalog: hunters the first mid model, judges the strongest. */
export function autoModels(models: ModelInfo[]): { hunter?: ModelInfo; judge?: ModelInfo } {
  const sorted = sortByTier(models);
  let hunter: ModelInfo | undefined;
  for (const t of HUNTER_PREF) {
    hunter = sorted.find((m) => m.tier === t);
    if (hunter) break;
  }
  return { hunter, judge: sorted[0] };
}

/** The model info a seat will be priced with: the connection's catalog entry, the registry's, else unknown. */
function modelFor(ref: ModelRef, models: ModelInfo[]): ModelInfo {
  const known = findInCatalog(models, ref.name) ?? findModel(ref.provider, ref.name);
  if (known) return known;
  return {
    provider: ref.provider,
    name: ref.name,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 0,
    maxOutputTokens: 0,
    tier: "mid",
  };
}

function seatUsd(model: ModelInfo, usage: TokenUsage): { usd: number; pessimistic: boolean } {
  const priced = withPricing(model);
  const r = priceUsage(priced, usage);
  return { usd: r.usd, pessimistic: model.pricing === undefined && !priced.zeroCost };
}

const tierFor = (level: 1 | 2 | 3): Tier => ({
  level,
  score: [0, 35, 65, 90][level] ?? 0,
  factors: { loc: TYPICAL_PR_LINES, files: TYPICAL_FILES, modules: 1, criticalPathHits: [] },
  reasons: [],
});

/**
 * Estimated cost per tier for a typical PR on one connection: the panel comes from the core's own seating (so
 * `--model` / defaultModel and the policy's `models.*` are honoured exactly as a review would), priced with the
 * registry and the core's per-seat token estimate. When the policy names connections other than this one, the
 * automatic choice for this connection is shown instead, with a note.
 */
export function tierCosts(
  models: ModelInfo[],
  policy: Policy = DEFAULT_POLICY,
  lines = TYPICAL_PR_LINES,
  connection?: ConnectionRecord,
): TierCost[] {
  const conn: ConnectionRecord = connection ?? {
    id: "this-connection",
    provider: models[0]?.provider ?? "unknown",
    kind: "api-key",
    createdAt: "",
  };
  const change = typicalChange(lines);
  const panelFor = (level: 1 | 2 | 3, p: Policy) =>
    seat({ tier: tierFor(level), change, policy: p, connections: [conn], catalog: () => models });
  let effective = policy;
  let note: string | undefined;
  try {
    panelFor(1, policy);
  } catch (err: unknown) {
    if (!(err instanceof SeatingError)) throw err;
    effective = {
      ...policy,
      models: { ...policy.models, hunters: undefined, judges: undefined, fallback: undefined, perLens: {} },
    };
    note = `the policy's models.* do not resolve on ${conn.id} (${err.message}); showing the automatic choice for this connection`;
  }
  return ([1, 2, 3] as const).map((level) => {
    let seats: Seat[] = [];
    let secondJudgeRound = false;
    try {
      const r = panelFor(level, effective);
      seats = r.seats;
      secondJudgeRound = r.secondJudgeRound;
    } catch (_err: unknown) {
      return {
        tier: level,
        hunters: 0,
        judges: 0,
        usd: 0,
        pessimistic: false,
        note: "no model to seat: this connection lists no models; pass --model <name>",
      };
    }
    let usd = 0;
    let pessimistic = false;
    let hunterModel: ModelInfo | undefined;
    let judgeModel: ModelInfo | undefined;
    for (const st of seats) {
      const m = modelFor(st.model, models);
      if (st.role === "hunter") hunterModel ??= m;
      else judgeModel ??= m;
      const tokens = seatTokens(st.role, lines, effective, st.role === "judge" && secondJudgeRound, m.contextTokens);
      const r = seatUsd(m, tokens);
      usd += r.usd;
      pessimistic ||= r.pessimistic;
    }
    return {
      tier: level,
      hunters: seats.filter((x) => x.role === "hunter").length,
      judges: seats.filter((x) => x.role === "judge").length,
      ...(hunterModel ? { hunterModel } : {}),
      ...(judgeModel ? { judgeModel } : {}),
      usd,
      pessimistic,
      ...(note ? { note } : {}),
    };
  });
}
