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
  type Change,
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
  type WorkspaceHandle,
} from "@merge-safely/core";
import { slackEscalation } from "@merge-safely/escalation-slack";
import { coreGateFactory, type GateFactory as EvalGateFactory } from "@merge-safely/evals";
import {
  checkRunReporter,
  checkRunStore,
  commitStatusReporter,
  githubSource,
  type OctokitLike,
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
import { CliError } from "./errors.js";
import type { CliEstimate, CliGate, CliReviewResult, GateFactory, GateSetup, Outcome } from "./gate-types.js";
import { isChangeRef } from "./gate-types.js";
import { quietOctokit } from "./github-api.js";
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
  /** Cancel support: reports an error for an unfinished change and disposes acquired workspaces. */
  abort: (reason: string) => Promise<void>;
}

const DEFAULT_VALIDATE_TIMEOUT_MS = 15_000;

function withTimeoutMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Connection ids the policy names explicitly (hunters, judges, per-lens). The fallback is optional by design. */
export function namedConnections(policy: Policy): string[] {
  const ids = [policy.models.hunters?.connection, policy.models.judges?.connection];
  for (const sel of Object.values(policy.models.perLens)) ids.push(sel.connection);
  return [...new Set(ids.filter((x): x is string => typeof x === "string"))];
}

/**
 * Validate connections before seating (`run`), with a timeout each. A connection the policy names that fails is
 * fatal (CONNECTION_UNREACHABLE naming it and the fix); with automatic model choice failed connections are dropped
 * with a warning, and it is fatal only when none is left. Models returned by validate prefill the catalog cache.
 */
export async function preflightConnections(
  registry: ProviderRegistry,
  connections: Connection[],
  policy: Policy,
  logger: Logger,
  timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS,
): Promise<{ connections: Connection[]; cache: Map<string, ModelInfo[]> }> {
  const cache = new Map<string, ModelInfo[]>();
  const results = await Promise.all(
    connections.map(async (conn) => {
      try {
        const v = await withTimeoutMs(registry.forConnection(conn).validate(conn), timeoutMs, `validating ${conn.id}`);
        if (v.ok && v.models && v.models.length > 0) cache.set(conn.id, v.models);
        return { conn, ok: v.ok, message: v.message ?? "validation failed" };
      } catch (err: unknown) {
        return { conn, ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  const fail = (r: (typeof results)[number]) =>
    new CliError(
      "CONNECTION_UNREACHABLE",
      `connection ${r.conn.id} is unreachable or rejected (${r.message}). Fix: check its key, base URL and network, then run \`merge-safely connections test ${r.conn.id}\``,
    );
  const named = new Set(namedConnections(policy));
  const namedFailure = failed.find((r) => named.has(r.conn.id));
  if (namedFailure) throw fail(namedFailure);
  const ok = results.filter((r) => r.ok).map((r) => r.conn);
  if (ok.length === 0 && failed[0]) throw fail(failed[0]);
  for (const r of failed) logger.warn(`connection ${r.conn.id} skipped: ${r.message}`);
  return { connections: ok, cache };
}

const FINAL_EVENTS: ReadonlySet<ReportEvent["type"]> = new Set(["verdict", "escalated", "budget-blocked", "error"]);

/** Build the GateDeps for a setup. Exported for tests of the wiring itself. */
export async function buildGateDeps(
  setup: GateSetup,
  registry: ProviderRegistry,
  overrides: GateOverrides = {},
): Promise<Wiring> {
  const { policy, paths, logger } = setup;
  let connections = setup.connections;
  let catalog: (connectionId: string) => ModelInfo[] = () => [];
  if (setup.catalog !== false) {
    let cache: Map<string, ModelInfo[]> | undefined;
    if (setup.validateConnections) {
      const pre = await preflightConnections(registry, connections, policy.policy, logger, setup.validateTimeoutMs);
      connections = pre.connections;
      cache = pre.cache;
    }
    const catalogData = await buildCatalog(registry, connections, cache ? { cache } : {});
    for (const p of catalogData.problems) logger.warn(`connection ${p.connectionId}: ${p.message}`);
    catalog = catalogLookup(catalogData);
  }

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
    const octokit: OctokitLike = overrides.octokit ? overrides.octokit(t.token) : quietOctokit(t.token, logger);
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

  // Track what is in flight so an interrupt can close it out (see `abort`).
  const handles = new Set<WorkspaceHandle>();
  let aborted = false;
  const tracked: Workspace = {
    async acquire(change, opts) {
      const h = await workspace.acquire(change, opts);
      if (aborted) {
        await h.dispose().catch(() => undefined);
        throw new Error("review interrupted");
      }
      const wrapped: WorkspaceHandle = {
        ...h,
        dispose: async () => {
          handles.delete(wrapped);
          await h.dispose();
        },
      };
      handles.add(wrapped);
      return wrapped;
    },
  };
  let open: { change: Change; round: number } | undefined;
  const trackedReporters: Reporter[] = reporters.map((r) => ({
    async report(e) {
      if (e.type === "pending") open = { change: e.change, round: e.round };
      else if (FINAL_EVENTS.has(e.type)) open = undefined;
      await r.report(e);
    },
  }));
  if (trackedReporters.length === 0) {
    trackedReporters.push({
      async report(e) {
        if (e.type === "pending") open = { change: e.change, round: e.round };
        else if (FINAL_EVENTS.has(e.type)) open = undefined;
      },
    });
  }
  const abort = async (reason: string): Promise<void> => {
    aborted = true;
    const pending = open;
    open = undefined;
    if (pending) {
      const event: ReportEvent = { type: "error", change: pending.change, error: reason, round: pending.round };
      await Promise.all(
        reporters.map((r) =>
          r.report(event).catch((err: unknown) => {
            logger.warn(`could not report the interruption: ${err instanceof Error ? err.message : String(err)}`);
          }),
        ),
      );
    }
    await Promise.all(
      [...handles].map((h) =>
        h.dispose().catch((err: unknown) => {
          logger.warn(`could not dispose workspace ${h.cwd}: ${err instanceof Error ? err.message : String(err)}`);
        }),
      ),
    );
  };

  const deps: GateDeps = {
    ...(source ? { source } : {}),
    workspace: tracked,
    providers: (conn) => registry.forConnection(conn),
    connections,
    catalog,
    store,
    reporters: trackedReporters,
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
  return { deps, reporters, abort };
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

export function adaptGate(g: Gate, policy: Policy, abort?: (reason: string) => Promise<void>): CliGate {
  return {
    ...(abort ? { abort } : {}),
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
    const { deps, abort } = await buildGateDeps(setup, registry(), overrides);
    return adaptGate(createGate(deps), setup.policy.policy, abort);
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
