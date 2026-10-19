/**
 * Seating (design 4.2 step 4): choose the lens set, seat count and models for a tiered change.
 *
 * - Hunter lenses come from `panel.t{1,2,3}.hunters` (tier 0 that reaches review uses t1). Lenses listed in
 *   `panel.conditionalLenses` are seated only when a changed path (or a rename's previous path) matches their globs.
 * - Model selection order: `models.perLens[lens]` → `models.hunters` / `models.judges` → automatic.
 *   Each catalog is viewed sorted by tier (frontier, mid, small), keeping the catalog's own order inside a tier:
 *   catalog order is a *preference* among equally strong models (the registry lists recommended models first).
 *   Automatic hunters take the first "mid" model of the hunter connection (falling back to frontier, then small).
 *   Automatic judges take the strongest tier available across ALL reachable connections; decorrelation only
 *   chooses among connections offering that tier, so a judge is never weaker than the best model on offer
 *   (and so never weaker than any hunter).
 * - With `models.decorrelate` and more than one reachable connection, hunter seats (other than per-lens overrides)
 *   alternate round-robin across connections, and automatic judges prefer an equally strong connection other than
 *   the one serving most hunters.
 * - A policy that names a connection the installation lacks, or a model a connection cannot reach, throws a
 *   SeatingError with a fix hint. A connection whose catalog is empty (no models endpoint) is trusted with a warning.
 *
 * Ids are compared with `normaliseModelId` (case, `[1m]`, vendor prefixes, date suffixes); pass `normalise` to
 * override (the registry re-exports the same function).
 *
 * Model knowledge is injected through `catalog` because core cannot depend on the registry.
 */
import { seatBudgetFromPolicy } from "../budget/seat-budget.js";
import type { ModelSelection, PanelTierPolicy, Policy } from "../policy/schema.js";
import { matchAny } from "../stages/glob.js";
import type {
  Change,
  ConnectionRecord,
  LensId,
  ModelInfo,
  ModelRef,
  ModelTierClass,
  Seat,
  SeatRole,
  Tier,
} from "../types.js";
import { SeatingError } from "./errors.js";
import { matchModelId, modelIdMatches, normaliseModelId } from "./model-id.js";

export interface SeatingInput {
  tier: Tier;
  change: Change;
  policy: Policy;
  connections: ConnectionRecord[];
  catalog: (connectionId: string) => ModelInfo[];
  /** Id normaliser for policy/catalog comparison; defaults to `normaliseModelId`. */
  normalise?: (id: string) => string;
}

export interface SeatingResult {
  seats: Seat[];
  warnings: string[];
  /** True when the tier policy asks for a second judge round (only meaningful with at least one judge). */
  secondJudgeRound: boolean;
}

/** Seat id lens for judge seats, which vote on findings rather than apply one lens. */
export const JUDGE_LENS: LensId = "judge";

export function tierPanelKey(level: Tier["level"]): "t1" | "t2" | "t3" {
  return level >= 3 ? "t3" : level === 2 ? "t2" : "t1";
}

/** The hunter lenses a tier seats for this change, after conditional-lens gating. */
export function lensesFor(tierPolicy: PanelTierPolicy, change: Change, policy: Policy): LensId[] {
  const paths = change.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
  const out: LensId[] = [];
  for (const lens of tierPolicy.hunters) {
    const globs = policy.panel.conditionalLenses[lens];
    if (globs && !paths.some((p) => matchAny(globs, p))) continue;
    if (!out.includes(lens)) out.push(lens);
  }
  return out;
}

/** Find a model in a catalog by a (possibly decorated or date-suffixed) id. See model-id.ts. */
export function findInCatalog(
  models: ModelInfo[],
  name: string,
  opts: { normalise?: (id: string) => string } = {},
): ModelInfo | undefined {
  return matchModelId(models, name, opts);
}

const TIER_RANK: Record<ModelTierClass, number> = { frontier: 2, mid: 1, small: 0 };

/** Stable sort: strongest tier first, catalog order (preference) within a tier. */
export function sortByTier(models: readonly ModelInfo[]): ModelInfo[] {
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => TIER_RANK[b.m.tier] - TIER_RANK[a.m.tier] || a.i - b.i)
    .map((x) => x.m);
}

const AUTO_PREFERENCE: Record<SeatRole, ModelTierClass[]> = {
  judge: ["frontier", "mid", "small"],
  hunter: ["mid", "frontier", "small"],
};

interface Resolved {
  ref: ModelRef;
  info?: ModelInfo;
}

export function seat(input: SeatingInput): SeatingResult {
  const { tier, change, policy, connections } = input;
  const warnings: string[] = [];
  const normalise = input.normalise ?? normaliseModelId;
  const panelKey = tierPanelKey(tier.level);
  const tierPolicy = policy.panel[panelKey];

  if (connections.length === 0) {
    throw new SeatingError(
      "No model connection is available for this installation, so no reviewer can be seated.",
      "Connect a provider (an API key, compatible endpoint, cloud or subscription connection) and re-run the check.",
    );
  }

  const catalogCache = new Map<string, ModelInfo[]>();
  const catalogOf = (id: string): ModelInfo[] => {
    let c = catalogCache.get(id);
    if (!c) {
      c = sortByTier(input.catalog(id));
      catalogCache.set(id, c);
    }
    return c;
  };
  const reachable = connections.filter((c) => catalogOf(c.id).length > 0 || c.defaultModel);
  if (reachable.length === 0) {
    throw new SeatingError(
      `None of the connected providers (${connections.map((c) => c.id).join(", ")}) offers any model.`,
      "Re-validate the connections, or set a default model on a connection whose provider has no models endpoint.",
    );
  }

  const lenses = lensesFor(tierPolicy, change, policy);
  if (lenses.length === 0) {
    throw new SeatingError(
      `panel.${panelKey}.hunters seats no lens for this change: every listed lens is conditional and none of its paths changed.`,
      `Add an unconditional lens (e.g. "correctness") to panel.${panelKey}.hunters.`,
      `panel.${panelKey}.hunters`,
    );
  }

  const noteModel = (r: Resolved, seatId: string, effort: string | undefined): void => {
    if (r.info && !r.info.pricing && !r.info.zeroCost) {
      warnings.push(
        `${seatId}: model "${r.ref.name}" has no known pricing; budgets use the pessimistic fallback rate.`,
      );
    }
    if (effort && r.info?.effortLevels && !r.info.effortLevels.includes(effort)) {
      warnings.push(
        `${seatId}: effort "${effort}" is not one of ${r.info.effortLevels.join("/")} for "${r.ref.name}".`,
      );
    }
  };

  const explicit = (sel: ModelSelection, key: string): Resolved => {
    const conn = connections.find((c) => c.id === sel.connection);
    if (!conn) {
      throw new SeatingError(
        `Policy ${key} names connection "${sel.connection}", which is not connected to this installation.`,
        `Connect "${sel.connection}", or change ${key}.connection to one of: ${connections.map((c) => c.id).join(", ")}.`,
        key,
      );
    }
    const models = catalogOf(conn.id);
    const ref: ModelRef = { connectionId: conn.id, provider: conn.provider, name: sel.model };
    if (sel.effort) ref.effort = sel.effort;
    if (models.length === 0) {
      warnings.push(`Connection "${conn.id}" lists no models; trusting ${key}.model "${sel.model}" unverified.`);
      return { ref };
    }
    const info = findInCatalog(models, sel.model, { normalise });
    if (!info) {
      const names = models.slice(0, 8).map((m) => m.name);
      throw new SeatingError(
        `Policy ${key} names model "${sel.model}", which connection "${conn.id}" cannot reach.`,
        `Change ${key}.model to a model "${conn.id}" offers (${names.join(", ")}${models.length > names.length ? ", …" : ""}), or connect a provider that serves it.`,
        key,
      );
    }
    return { ref, info };
  };

  const auto = (conn: ConnectionRecord, role: SeatRole): Resolved => {
    const models = catalogOf(conn.id);
    for (const t of AUTO_PREFERENCE[role]) {
      const m = models.find((x) => x.tier === t);
      if (m) {
        if (t !== AUTO_PREFERENCE[role][0] && t !== "frontier") {
          warnings.push(
            `Connection "${conn.id}" has no ${AUTO_PREFERENCE[role][0]} model; ${role}s use "${m.name}" (${t}).`,
          );
        }
        return { ref: { connectionId: conn.id, provider: conn.provider, name: m.name }, info: m };
      }
    }
    // Only reachable via defaultModel with an empty catalog.
    warnings.push(
      `Connection "${conn.id}" lists no models; using its default model "${conn.defaultModel}" unverified.`,
    );
    return { ref: { connectionId: conn.id, provider: conn.provider, name: conn.defaultModel as string } };
  };

  const tierOfRef = (ref: ModelRef): number => {
    const m = findInCatalog(catalogOf(ref.connectionId), ref.name, { normalise });
    return m ? TIER_RANK[m.tier] : -1;
  };

  const hunterBase: Resolved = policy.models.hunters
    ? explicit(policy.models.hunters, "models.hunters")
    : auto(reachable[0] as ConnectionRecord, "hunter");
  const primaryId = hunterBase.ref.connectionId;
  const decorrelate = policy.models.decorrelate && reachable.length > 1;
  const rotation: ConnectionRecord[] = decorrelate
    ? [
        ...(reachable.filter((c) => c.id === primaryId) as ConnectionRecord[]),
        ...reachable.filter((c) => c.id !== primaryId),
      ]
    : [];
  if (decorrelate && rotation[0]?.id !== primaryId) {
    // Primary has an empty catalog and no default model but was named explicitly: keep it first anyway.
    const primary = connections.find((c) => c.id === primaryId);
    if (primary) rotation.unshift(primary);
  }

  const seats: Seat[] = [];
  const hunterBudget = seatBudgetFromPolicy(policy, "hunter");
  const perLensCount = new Map<LensId, number>();
  let rr = 0;
  for (const lens of lenses) {
    const n = (perLensCount.get(lens) ?? 0) + 1;
    perLensCount.set(lens, n);
    const id = `hunter:${lens}:${n}`;
    const override = policy.models.perLens[lens];
    let r: Resolved;
    if (override) {
      r = explicit(override, `models.perLens.${lens}`);
    } else if (decorrelate) {
      const conn = rotation[rr % rotation.length] as ConnectionRecord;
      rr++;
      r = conn.id === primaryId ? hunterBase : auto(conn, "hunter");
    } else {
      r = hunterBase;
    }
    noteModel(r, id, r.ref.effort);
    seats.push({ id, lens, role: "hunter", model: { ...r.ref }, budget: { ...hunterBudget } });
  }

  const judgeBudget = seatBudgetFromPolicy(policy, "judge");
  if (tierPolicy.judges > 0) {
    let judgeModels: Resolved[];
    if (policy.models.judges) {
      judgeModels = [explicit(policy.models.judges, "models.judges")];
    } else {
      // Strongest tier on offer anywhere; only connections offering it are candidates.
      const bestRank = (c: ConnectionRecord): number => {
        const top = catalogOf(c.id)[0];
        return top ? TIER_RANK[top.tier] : -1;
      };
      const best = Math.max(...reachable.map(bestRank));
      const strongest = reachable.filter((c) => bestRank(c) === best);
      let pool = strongest;
      if (decorrelate) {
        const counts = new Map<string, number>();
        for (const s of seats) counts.set(s.model.connectionId, (counts.get(s.model.connectionId) ?? 0) + 1);
        const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const others = strongest.filter((c) => c.id !== majority);
        if (others.length > 0) pool = others;
      }
      judgeModels = (decorrelate ? pool : pool.slice(0, 1)).map((c) => auto(c, "judge"));
    }
    const hunterTop = Math.max(-1, ...seats.map((s) => tierOfRef(s.model)));
    for (const r of judgeModels) {
      const t = tierOfRef(r.ref);
      if (t >= 0 && t < hunterTop) {
        warnings.push(`Judge model "${r.ref.name}" is a weaker tier than the strongest hunter model.`);
      }
    }
    for (let i = 0; i < tierPolicy.judges; i++) {
      const id = `judge:${i + 1}`;
      const r = judgeModels[i % judgeModels.length] as Resolved;
      noteModel(r, id, r.ref.effort);
      seats.push({ id, lens: JUDGE_LENS, role: "judge", model: { ...r.ref }, budget: { ...judgeBudget } });
    }
  }

  return { seats, warnings, secondJudgeRound: tierPolicy.secondJudgeRound && tierPolicy.judges > 0 };
}

/**
 * The fallback model for a seat when its primary is rate limited or down (`models.fallback`). Undefined when no
 * fallback is configured, its connection is missing, the model is unreachable, or it is the seat's own model.
 */
export function planFallback(
  seatToCover: Seat,
  policy: Policy,
  connections: ConnectionRecord[],
  catalog: (connectionId: string) => ModelInfo[],
  opts: { normalise?: (id: string) => string } = {},
): ModelRef | undefined {
  const normalise = opts.normalise ?? normaliseModelId;
  const sel = policy.models.fallback;
  if (!sel) return undefined;
  const conn = connections.find((c) => c.id === sel.connection);
  if (!conn) return undefined;
  const models = catalog(conn.id);
  if (models.length > 0 && !findInCatalog(models, sel.model, { normalise })) return undefined;
  if (seatToCover.model.connectionId === conn.id) {
    const a = normalise(seatToCover.model.name);
    const b = normalise(sel.model);
    // Same model, or one is a dated/decorated variant of the other.
    if (modelIdMatches(a, b) || modelIdMatches(b, a)) return undefined;
  }
  const ref: ModelRef = { connectionId: conn.id, provider: conn.provider, name: sel.model };
  if (sel.effort) ref.effort = sel.effort;
  return ref;
}

/** Multi-line, plain-text description of a panel for the `estimate` command and logs. */
export function describeSeating(seats: Seat[], estimates?: (seat: Seat) => number | undefined): string {
  const hunters = seats.filter((s) => s.role === "hunter").length;
  const judges = seats.length - hunters;
  const width = Math.max(0, ...seats.map((s) => s.id.length));
  const lines = [`Panel: ${hunters} hunter${hunters === 1 ? "" : "s"}, ${judges} judge${judges === 1 ? "" : "s"}`];
  for (const s of seats) {
    const model = `${s.model.connectionId}/${s.model.name}${s.model.effort ? ` (effort ${s.model.effort})` : ""}`;
    const caps = [
      s.budget.maxUsd !== undefined ? `max $${s.budget.maxUsd.toFixed(2)}` : "no $ cap",
      `${s.budget.maxTurns} turns`,
      `${Math.round(s.budget.deadlineMs / 60_000)}m`,
    ];
    const est = estimates?.(s);
    if (est !== undefined) caps.unshift(`est $${est.toFixed(2)}`);
    const down = s.downgradedFrom ? ` [downgraded from ${s.downgradedFrom.connectionId}/${s.downgradedFrom.name}]` : "";
    lines.push(`  ${s.id.padEnd(width)}  ${model}  ${caps.join(", ")}${down}`);
  }
  return lines.join("\n");
}
