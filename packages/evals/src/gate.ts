/**
 * The gate the eval runner drives, and the factories that build one per case.
 *
 * `EvalGate` is the structural subset of the core orchestrator's `Gate` (`createGate(deps)` in
 * `@merge-safely/core`) that evals use: `reviewChange` for full runs and `estimate` for tiering, triage and seating.
 * Any real `Gate` satisfies it (checked at compile time by `asEvalGate`). `coreGateFactory(deps)` builds one
 * orchestrator gate per case over the case's fresh store, ledger and workspace. Tests inject scripted gates instead.
 *
 * `estimateOnlyGate` is built from the real pure core stages (tier, triage, seat) with synthetic connections, so dry
 * runs exercise exactly the tiering and triage logic production uses without any model, network or credentials.
 */
import {
  type Change,
  type ConnectionRecord,
  type CostLedger,
  createGate,
  type Gate,
  type GateDeps,
  type HumanDigest,
  type ModelInfo,
  type Policy,
  type Seat,
  seat,
  type Tier,
  tier as tierOf,
  triage,
  type UntrustedText,
  type Verdict,
  type VerdictStore,
  type Workspace,
} from "@merge-safely/core";

export interface GateReviewInput {
  diff: string;
  deltaDiff?: string;
  untrusted?: UntrustedText;
}

export interface GateReviewResult {
  verdict: Verdict;
  digest: HumanDigest;
  /** Report events emitted during the review; evals only count them. */
  events: readonly unknown[];
  /** A stored, unresolved block for this SHA prevented this result from replacing it. */
  contested?: boolean;
  /** The run could not decide (outage, insufficient seats, budget refusal). */
  pendingReason?: string;
}

export interface GateTriage {
  decision: "auto-pass" | "review";
  reason: string;
}

export interface GateEstimate {
  tier: Tier;
  /** Null or absent when the gate did not run triage (treated as "review"). */
  triage?: GateTriage | null;
  seats: Seat[];
  estimateUsd?: number;
  warnings?: string[];
}

export interface EvalGate {
  reviewChange(change: Change, input: GateReviewInput): Promise<GateReviewResult>;
  estimate(change: Change): Promise<GateEstimate> | GateEstimate;
}

/** Fresh, per-case state handed to the factory: nothing is shared between cases. */
export interface GateFactoryContext {
  caseId: string;
  store: VerdictStore;
  ledger: CostLedger;
  /**
   * Fixture cases: the throwaway repository holding baseSha and headSha. It stays alive until the case's review
   * has finished, then it is deleted, so handles acquired from it must be disposed by then.
   */
  repo?: { repoPath: string; headSha: string; baseSha: string };
  /**
   * Reviewer workspace for the case: by default `localWorkspace({ repoPath })` over `repo`. Absent for diff and
   * github cases unless the runner's `workspace` option supplies one (those are diff-only otherwise).
   */
  workspace?: Workspace;
}

export type GateFactory = (policy: Policy, ctx: GateFactoryContext) => EvalGate | Promise<EvalGate>;

export class GateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateUnavailableError";
  }
}

const SYNTHETIC_PROVIDER = "evals-synthetic";

function syntheticModel(name: string, modelTier: ModelInfo["tier"]): ModelInfo {
  return {
    provider: SYNTHETIC_PROVIDER,
    name,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    zeroCost: true,
    tier: modelTier,
    source: "evals",
  };
}

/**
 * Connections and catalogs that satisfy whatever the policy names: every connection referenced in `policy.models`
 * exists and offers the named models, plus a default connection with a mid and a frontier model for automatic picks.
 */
export function syntheticConnections(policy: Policy): {
  connections: ConnectionRecord[];
  catalog: (id: string) => ModelInfo[];
} {
  const catalogs = new Map<string, ModelInfo[]>();
  const add = (connection: string, model?: string) => {
    const list = catalogs.get(connection) ?? [];
    if (model && !list.some((m) => m.name === model)) list.push(syntheticModel(model, "frontier"));
    catalogs.set(connection, list);
  };
  const m = policy.models;
  for (const sel of [m.hunters, m.judges, m.fallback, ...Object.values(m.perLens)]) {
    if (sel) add(sel.connection, sel.model);
  }
  if (catalogs.size === 0) {
    catalogs.set("evals", [syntheticModel("evals-frontier", "frontier"), syntheticModel("evals-mid", "mid")]);
  }
  for (const [id, list] of catalogs) {
    if (!list.some((x) => x.tier === "mid")) list.push(syntheticModel(`${id}-mid`, "mid"));
  }
  const connections: ConnectionRecord[] = [...catalogs.keys()].map((id) => ({
    id,
    provider: SYNTHETIC_PROVIDER,
    kind: "api-key",
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  return { connections, catalog: (id) => catalogs.get(id) ?? [] };
}

/** Tier, triage and seating from the real core stages. Pure. */
export function estimateWithStages(change: Change, policy: Policy): GateEstimate {
  const t = tierOf(change, policy);
  const tr = triage(change, t, policy);
  if (tr.decision === "auto-pass") return { tier: t, triage: tr, seats: [], estimateUsd: 0 };
  const { connections, catalog } = syntheticConnections(policy);
  const seated = seat({ tier: t, change, policy, connections, catalog });
  return { tier: t, triage: tr, seats: seated.seats, warnings: seated.warnings };
}

/**
 * A gate whose `estimate` runs the real tier, triage and seating stages and whose `reviewChange` refuses. Used for
 * `--dry` runs, which never call a model.
 */
export function estimateOnlyGate(policy: Policy): EvalGate {
  return {
    async reviewChange(): Promise<GateReviewResult> {
      throw new GateUnavailableError(
        "this gate only estimates; pass a gateFactory that builds the orchestrator gate (createGate) for full runs, or use --dry",
      );
    },
    estimate: (change) => estimateWithStages(change, policy),
  };
}

export const estimateOnlyGateFactory: GateFactory = (policy) => estimateOnlyGate(policy);

/** Compile-time proof that the orchestrator's Gate satisfies EvalGate. */
export function asEvalGate(gate: Gate): EvalGate {
  return {
    estimate: (change) => gate.estimate(change),
    // persist: true so the verdict goes through the store's compare-and-set like production (the store is fresh).
    reviewChange: (change, input) => gate.reviewChange(change, input, { persist: true, trigger: "eval" }),
  };
}

/** Deps for `coreGateFactory`: everything except what the runner supplies per case. */
export type CoreGateDeps = Omit<GateDeps, "policy" | "store" | "ledger" | "workspace"> & {
  /** Used when the case has no workspace of its own (diff and github cases). */
  workspace?: Workspace;
};

/**
 * A GateFactory over the real orchestrator: one `createGate` per case with that case's policy, fresh store and
 * ledger, and the case workspace (the fixture repository) or `deps.workspace` as a fallback.
 */
export function coreGateFactory(deps: CoreGateDeps): GateFactory {
  return (policy, ctx) => {
    const workspace = ctx.workspace ?? deps.workspace;
    if (!workspace) {
      throw new GateUnavailableError(
        `case ${ctx.caseId} has no reviewer workspace (diff or github source); pass deps.workspace or the runner's workspace option`,
      );
    }
    return asEvalGate(createGate({ ...deps, policy, store: ctx.store, ledger: ctx.ledger, workspace }));
  };
}
