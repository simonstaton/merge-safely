/**
 * The one module that wires the real gate. Everything else in the CLI talks to `CliGate` (gate-types.ts).
 *
 * Wiring (design 6.3 / 6.4): every shipped provider (`allProviders()`) behind a ProviderRegistry; the catalog from
 * `buildCatalog`; pricing from the registry; prompts from the lenses; the read-only tool set; a local git
 * workspace (a disposable clone for PR review, the working tree for --local); a verdict store, ledger and
 * reporters chosen by the flags.
 */
import { join } from "node:path";
import {
  type Connection,
  type CostLedger,
  createGate,
  type Escalation,
  type Estimate,
  findInCatalog,
  type Gate,
  type GateDeps,
  type Logger,
  type ModelInfo,
  type ModelRef,
  type Policy,
  type Pricing,
  type PromptBuilders,
  type ReportEvent,
  type Reporter,
  type ReviewResult,
  renderDigest,
  type SourceProvider,
  type TrustProvider,
  type VerdictStore,
  type Workspace,
} from "@merge-safely/core";
import { slackEscalation } from "@merge-safely/escalation-slack";
import { coreGateFactory, type GateFactory as EvalGateFactory } from "@merge-safely/evals";
import {
  checkRunReporter,
  checkRunStore,
  commitStatusReporter,
  githubSource,
  type OctokitLike,
  octokitFromToken,
  prReviewReporter,
  trustFromPolicy,
} from "@merge-safely/github";
import { buildHunterPrompt, buildJudgePrompt, requireLens } from "@merge-safely/lenses";
import { allProviders } from "@merge-safely/provider-compatible";
import { buildCatalog, catalogLookup, createProviderRegistry, type ProviderRegistry } from "@merge-safely/providers";
import { cheaperModel, normaliseModelId, priceUsage, withPricing } from "@merge-safely/registry";
import { fsCostLedger, fsVerdictStore } from "@merge-safely/store-fs";
import { memoryVerdictStore } from "@merge-safely/store-memory";
import { sqliteStores } from "@merge-safely/store-sqlite";
import { createReadOnlyTools } from "@merge-safely/tools";
import { currentTreeWorkspace, localWorkspace } from "@merge-safely/workspace-local";
import type { CliEstimate, CliGate, CliReviewResult, GateFactory, GateSetup, Outcome } from "./gate-types.js";
import { isChangeRef } from "./gate-types.js";
import { CLI_VERSION } from "./version.js";

/** Default seats run in parallel by the CLI (`--concurrency`). Lower than the core's 4 to be gentle on rate limits. */
export const DEFAULT_CONCURRENCY = 2;

/** Every shipped provider: anthropic, openai, gemini and the compatible / local presets. */
export function defaultProviderRegistry(): ProviderRegistry {
  return createProviderRegistry(allProviders());
}

/** Captures every event, for --local (nothing is posted anywhere). */
export function memoryReporter(): Reporter & { events: ReportEvent[] } {
  const events: ReportEvent[] = [];
  return {
    events,
    async report(e) {
      events.push(e);
    },
  };
}

/** Registry-backed pricing handed to the core (it cannot depend on the registry itself). */
export function registryPricing(): Pricing {
  return {
    withPricing,
    normalise: normaliseModelId,
    price: (model, usage) => priceUsage(withPricing(model), usage),
    cheaper: (ref: ModelRef, models: ModelInfo[]): ModelRef | undefined => {
      const current = findInCatalog(models, ref.name, { normalise: normaliseModelId });
      if (!current) return undefined;
      const next = cheaperModel(ref.provider, current);
      if (!next) return undefined;
      const reachable = models.length === 0 ? next : findInCatalog(models, next.name, { normalise: normaliseModelId });
      if (!reachable) return undefined;
      return { connectionId: ref.connectionId, provider: ref.provider, name: reachable.name };
    },
  };
}

/** Lens prompt builders keyed by lens id, as the core expects. */
export const lensPrompts: PromptBuilders = {
  hunter(lens, input, opts) {
    const p = buildHunterPrompt(requireLens(lens), input, opts ?? {});
    return { system: p.system, user: p.user };
  },
  judge(input, opts) {
    const p = buildJudgePrompt(input, opts ?? {});
    return { system: p.system, user: p.user };
  },
};

/** Seams for tests and embedders: a GitHub client and a workspace instead of the real ones. */
export interface GateOverrides {
  octokit?: (token: string) => OctokitLike;
  workspace?: (setup: GateSetup) => Workspace | undefined;
}

export interface Wiring {
  deps: GateDeps;
  reporters: Reporter[];
}

/** Build the GateDeps for a setup. Exported for tests of the wiring itself. */
export async function buildGateDeps(
  setup: GateSetup,
  registry: ProviderRegistry,
  overrides: GateOverrides = {},
): Promise<Wiring> {
  const { policy, connections, paths, logger } = setup;
  const catalogData = await buildCatalog(registry, connections);
  for (const p of catalogData.problems) logger.warn(`connection ${p.connectionId}: ${p.message}`);
  const catalog = catalogLookup(catalogData);

  let source: SourceProvider | undefined;
  let workspace: Workspace;
  let store: VerdictStore;
  let ledger: CostLedger;
  let trust: TrustProvider | undefined;
  let escalation: Escalation | undefined;
  const reporters: Reporter[] = [];
  let installationId: string;

  const t = setup.target;
  if (t.mode === "local") {
    workspace = overrides.workspace?.(setup) ?? currentTreeWorkspace(t.root);
    store = memoryVerdictStore();
    ledger = fsCostLedger(paths.store);
    reporters.push(memoryReporter());
    installationId = "local";
  } else {
    const octokit: OctokitLike = overrides.octokit ? overrides.octokit(t.token) : octokitFromToken(t.token);
    source = githubSource({ octokit });
    workspace =
      overrides.workspace?.(setup) ??
      localWorkspace({
        cloneUrl: `https://${t.repo.host}/${t.repo.owner}/${t.repo.name}.git`,
        token: t.token,
        cacheDir: join(paths.repos, `${t.repo.owner}__${t.repo.name}.git`),
      });
    installationId = `${t.repo.owner}/${t.repo.name}`;
    trust = trustFromPolicy(policy.policy, octokit, logger);
    const sqlite = t.store === "sqlite" ? sqliteStores({ path: paths.sqlite }) : undefined;
    ledger = sqlite ? sqlite.ledger : fsCostLedger(paths.store);
    if (t.dryRun) store = memoryVerdictStore();
    else if (sqlite) store = sqlite.verdicts;
    else if (t.store === "checkrun") store = checkRunStore({ octokit, policy: policy.policy, logger });
    else if (t.store === "memory") store = memoryVerdictStore();
    else store = fsVerdictStore(paths.store);
    if (!t.dryRun) {
      if (t.report === "github") {
        reporters.push(checkRunReporter({ octokit, policy: policy.policy }));
        if (policy.policy.reporting.postPrReview) reporters.push(prReviewReporter({ octokit, policy: policy.policy }));
      } else if (t.report === "status") {
        reporters.push(commitStatusReporter({ octokit, policy: policy.policy }));
        if (policy.policy.reporting.postPrReview) reporters.push(prReviewReporter({ octokit, policy: policy.policy }));
      }
      if (setup.slackWebhook) escalation = slackEscalation({ webhookUrl: setup.slackWebhook });
    }
  }

  const deps: GateDeps = {
    ...(source ? { source } : {}),
    workspace,
    providers: (conn) => registry.forConnection(conn),
    connections,
    catalog,
    store,
    reporters,
    ledger,
    ...(trust ? { trust } : {}),
    ...(escalation ? { escalation } : {}),
    policy: policy.policy,
    policyHash: policy.hash,
    tools: createReadOnlyTools,
    prompts: lensPrompts,
    pricing: registryPricing(),
    installationId,
    // The CLI cannot see installation-wide monthly spend across machines; report it, never block on it.
    advisoryCeilings: ["monthly"],
    concurrency: setup.concurrency ?? DEFAULT_CONCURRENCY,
    logger,
    producedBy: `merge-safely-cli@${CLI_VERSION}`,
  };
  return { deps, reporters };
}

// ---------------------------------------------------------------------------------------------------------------
// Adapting the core Gate to CliGate.
// ---------------------------------------------------------------------------------------------------------------

/** Map a core ReviewResult to the CLI outcome that drives the exit code. */
export function toCliResult(r: ReviewResult): CliReviewResult {
  const v = r.verdict;
  const budget = r.events.find((e) => e.type === "budget-blocked");
  const errorEvent = r.events.find((e) => e.type === "error");
  let outcome: Outcome;
  if (budget && v.decision === "pending") outcome = "budget-blocked";
  else if (r.contested || v.contested) outcome = "contested";
  else outcome = v.decision;
  const reason =
    r.pendingReason ??
    (budget?.type === "budget-blocked" ? budget.reason : undefined) ??
    (errorEvent?.type === "error" ? errorEvent.error : undefined) ??
    (v.decision === "pending" ? v.reason : undefined);
  return { outcome, digest: r.digest, verdict: v, tier: v.tier, ...(reason ? { reason } : {}) };
}

/** Map a core Estimate to the CLI's flat shape (per-seat dollars come from the per-seat ceiling rows). */
export function toCliEstimate(e: Estimate): CliEstimate {
  const perSeat = new Map<string, number>();
  for (const c of e.ceilings) if (c.ceiling === "per-seat" && c.seatId) perSeat.set(c.seatId, c.projectedUsd);
  const unknown = new Set(e.unknownSeats);
  return {
    tier: e.tier,
    ...(e.triage.decision === "auto-pass" ? { triaged: { reason: e.triage.reason } } : {}),
    seats: e.seats.map((s) => {
      const usd = unknown.has(s.id) ? undefined : perSeat.get(s.id);
      return {
        id: s.id,
        role: s.role,
        lens: s.lens,
        connectionId: s.model.connectionId,
        provider: String(s.model.provider),
        model: s.model.name,
        ...(usd !== undefined ? { usd } : {}),
        ...(s.downgradedFrom ? { downgradedFrom: `${s.downgradedFrom.connectionId}/${s.downgradedFrom.name}` } : {}),
      };
    }),
    ...(e.estimateUsd !== undefined ? { usd: e.estimateUsd } : {}),
    unknownSeats: e.unknownSeats,
    ceilings: e.ceilings
      .filter((c) => c.ceiling !== "per-seat")
      .map((c) => ({
        ceiling: c.ceiling,
        limitUsd: c.limitUsd,
        currentUsd: c.currentUsd,
        projectedUsd: c.projectedUsd,
        breached: c.breached,
        ...(c.advisory ? { advisory: true } : {}),
      })),
    admitted: !e.budgetBlocked,
    ...(e.budgetBlocked ? { blockedReason: e.budgetBlocked.message } : {}),
    downgrades: e.downgrades ?? [],
    warnings: [],
  };
}

export function adaptGate(g: Gate, policy: Policy): CliGate {
  return {
    async review(ref, opts) {
      return toCliResult(
        await g.review(ref, opts.headSha ? { headSha: opts.headSha, trigger: "cli" } : { trigger: "cli" }),
      );
    },
    async reviewChange(input) {
      const untrusted = {
        ...(input.untrusted.commitMessages ? { commitMessages: input.untrusted.commitMessages } : {}),
        ...(input.untrusted.comments ? { comments: input.untrusted.comments } : {}),
      };
      // --local: never stored, never escalated (persist: false); reporters still see every event.
      return toCliResult(
        await g.reviewChange(input.change, { diff: input.diff, untrusted }, { persist: false, trigger: "cli-local" }),
      );
    },
    async estimate(target) {
      return toCliEstimate(await g.estimate(isChangeRef(target) ? target : target.change));
    },
    async explain(ref) {
      const r = await g.explain(ref);
      if (!r.verdict) return null;
      return { verdict: r.verdict, digest: r.digest ?? renderDigest(r.verdict, { policy }) };
    },
    async recordHumanVerdict(input) {
      return g.recordHumanVerdict(input);
    },
  };
}

/** The production GateFactory. */
export function realGateFactory(
  registry: () => ProviderRegistry = defaultProviderRegistry,
  overrides: GateOverrides = {},
): GateFactory {
  return async (setup) => {
    const { deps } = await buildGateDeps(setup, registry(), overrides);
    return adaptGate(createGate(deps), setup.policy.policy);
  };
}

/**
 * The gate factory `merge-safely eval` drives for full (non --dry) runs: the real orchestrator per case over the
 * CLI's connections and providers. The eval runner supplies each case's policy, store, ledger and workspace.
 */
export async function evalGateFactory(
  connections: Connection[],
  registry: ProviderRegistry,
  logger: Logger,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<EvalGateFactory> {
  const catalogData = await buildCatalog(registry, connections);
  for (const p of catalogData.problems) logger.warn(`connection ${p.connectionId}: ${p.message}`);
  return coreGateFactory({
    providers: (conn) => registry.forConnection(conn),
    connections,
    catalog: catalogLookup(catalogData),
    reporters: [],
    tools: createReadOnlyTools,
    prompts: lensPrompts,
    pricing: registryPricing(),
    installationId: "evals",
    advisoryCeilings: ["monthly"],
    concurrency,
    logger,
    producedBy: `merge-safely-cli@${CLI_VERSION}`,
  });
}
