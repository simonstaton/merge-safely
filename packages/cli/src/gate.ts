/**
 * The one module that wires the real gate. Everything else in the CLI talks to `CliGate` (gate-types.ts).
 *
 * Wiring (design 6.3 / 6.4): providers from the shipped adapters behind a ProviderRegistry; the catalog from
 * `buildCatalog`; pricing from the registry; prompts from the lenses; the read-only tool set; a local git
 * workspace (a disposable clone for PR review, the working tree for --local); a verdict store, ledger and
 * reporters chosen by the flags.
 */
import { join } from "node:path";
import type {
  ChangeRef,
  Connection,
  CostLedger,
  Escalation,
  HumanDigest,
  ModelInfo,
  ModelProvider,
  ModelRef,
  ReportEvent,
  Reporter,
  SourceProvider,
  TokenUsage,
  TrustProvider,
  Verdict,
  VerdictStore,
  Workspace,
} from "@merge-safely/core";
import * as core from "@merge-safely/core";
import { slackEscalation } from "@merge-safely/escalation-slack";
import {
  checkRunReporter,
  checkRunStore,
  commitStatusReporter,
  githubSource,
  octokitFromToken,
  prReviewReporter,
  trustFromPolicy,
} from "@merge-safely/github";
import { buildHunterPrompt, buildJudgePrompt } from "@merge-safely/lenses";
import { anthropicProvider } from "@merge-safely/provider-anthropic";
import { geminiProvider } from "@merge-safely/provider-gemini";
import { openaiCompatibleProvider, openaiProvider } from "@merge-safely/provider-openai";
import { buildCatalog, catalogLookup, createProviderRegistry, type ProviderRegistry } from "@merge-safely/providers";
import { cheaperModel, normaliseModelId, priceUsage, withPricing } from "@merge-safely/registry";
import { fsCostLedger, fsVerdictStore } from "@merge-safely/store-fs";
import { memoryVerdictStore } from "@merge-safely/store-memory";
import { sqliteStores } from "@merge-safely/store-sqlite";
import { createReadOnlyTools } from "@merge-safely/tools";
import { currentTreeWorkspace, localWorkspace } from "@merge-safely/workspace-local";
import { CliError } from "./errors.js";
import type {
  CliEstimate,
  CliGate,
  CliReviewResult,
  GateFactory,
  GateSetup,
  HumanVerdictInput,
  LocalReviewInput,
  Outcome,
} from "./gate-types.js";
import { isChangeRef } from "./gate-types.js";
import { CLI_VERSION } from "./version.js";

/** The shipped providers. `providersOverride` lets tests and embedders swap in their own. */
export function defaultProviderRegistry(): ProviderRegistry {
  return createProviderRegistry([anthropicProvider(), openaiProvider(), openaiCompatibleProvider(), geminiProvider()]);
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
export function registryPricing(catalog: (connectionId: string) => ModelInfo[]) {
  return {
    withPricing,
    normalise: normaliseModelId,
    price: (model: ModelInfo, usage: TokenUsage) => priceUsage(withPricing(model), usage),
    cheaper: (ref: ModelRef, lookup: (connectionId: string) => ModelInfo[] = catalog): ModelRef | undefined => {
      const models = lookup(ref.connectionId);
      const current = core.findInCatalog(models, ref.name, { normalise: normaliseModelId });
      if (!current) return undefined;
      const next = cheaperModel(ref.provider, current);
      if (!next) return undefined;
      const reachable = models.length === 0 ? next : core.findInCatalog(models, next.name);
      if (!reachable) return undefined;
      return { connectionId: ref.connectionId, provider: ref.provider, name: reachable.name };
    },
  };
}

interface Wiring {
  deps: Record<string, unknown>;
  reporters: Reporter[];
}

/** Build the GateDeps for a setup. Exported for tests of the wiring itself. */
export async function buildGateDeps(setup: GateSetup, registry: ProviderRegistry): Promise<Wiring> {
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
    workspace = currentTreeWorkspace(t.root);
    store = memoryVerdictStore();
    ledger = fsCostLedger(paths.store);
    reporters.push(memoryReporter());
    installationId = "local";
  } else {
    const octokit = octokitFromToken(t.token);
    source = githubSource({ octokit });
    workspace = localWorkspace({
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

  const deps: Record<string, unknown> = {
    ...(source ? { source } : {}),
    workspace,
    providers: (conn: Connection): ModelProvider => registry.forConnection(conn),
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
    prompts: { hunter: buildHunterPrompt, judge: buildJudgePrompt },
    pricing: registryPricing(catalog),
    installationId,
    // The CLI cannot see installation-wide monthly spend across machines; report it, never block on it.
    advisoryCeilings: ["monthly"],
    logger,
    producedBy: `merge-safely-cli@${CLI_VERSION}`,
  };
  return { deps, reporters };
}

// ---------------------------------------------------------------------------------------------------------------
// Adapting the core Gate to CliGate.
//
// PENDING ORCHESTRATOR: `createGate` is being built in packages/core/src/orchestrator. Until it is on main it is
// looked up at runtime, and its results are normalised defensively below. Once it lands this section becomes a
// typed import (`import { createGate, type Gate, GateError } from "@merge-safely/core"`).
// ---------------------------------------------------------------------------------------------------------------

interface CoreGateLike {
  review(ref: ChangeRef, opts?: { headSha?: string }): Promise<unknown>;
  reviewChange(change: unknown, opts: { diff: string; untrusted?: unknown }): Promise<unknown>;
  estimate(target: unknown): Promise<unknown>;
  explain(ref: ChangeRef): Promise<unknown>;
  recordHumanVerdict(input: HumanVerdictInput): Promise<unknown>;
}

type CreateGateFn = (deps: Record<string, unknown>) => CoreGateLike;

function resolveCreateGate(): CreateGateFn {
  const fn: unknown = (core as Record<string, unknown>).createGate;
  if (typeof fn !== "function") {
    throw new CliError(
      "GATE_UNAVAILABLE",
      "this build of @merge-safely/core has no review orchestrator (createGate); update merge-safely",
    );
  }
  return fn as CreateGateFn;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isVerdict(x: unknown): x is Verdict {
  return isRecord(x) && typeof x.decision === "string" && typeof x.headSha === "string" && isRecord(x.tier);
}

function isDigest(x: unknown): x is HumanDigest {
  return isRecord(x) && typeof x.text === "string" && typeof x.markdown === "string";
}

export function outcomeOf(v: Verdict): Outcome {
  if (v.contested) return "contested";
  return v.decision;
}

/** Normalise a core ReviewResult into the CLI's shape. */
export function toCliResult(raw: unknown, policy: core.Policy): CliReviewResult {
  const r = isRecord(raw) ? raw : {};
  const verdict = isVerdict(r.verdict) ? r.verdict : isVerdict(raw) ? raw : undefined;
  const digest = isDigest(r.digest) ? r.digest : verdict ? core.renderDigest(verdict, { policy }) : undefined;
  const status = typeof r.status === "string" ? r.status : typeof r.outcome === "string" ? r.outcome : undefined;
  const reason = typeof r.reason === "string" ? r.reason : typeof r.error === "string" ? r.error : undefined;
  const budget = status === "budget-blocked" || r.budgetBlocked === true;
  let outcome: Outcome;
  if (budget) outcome = "budget-blocked";
  else if (status === "error") outcome = "error";
  else if (verdict) outcome = outcomeOf(verdict);
  else outcome = "error";
  return {
    outcome,
    digest: digest ?? {
      headline: `Verdict: ${outcome.toUpperCase()}`,
      markdown: reason ?? "",
      text: `Verdict: ${outcome.toUpperCase()}${reason ? `\n${reason}` : ""}`,
    },
    ...(verdict ? { verdict, tier: verdict.tier } : isRecord(r.tier) ? { tier: r.tier as unknown as core.Tier } : {}),
    ...(reason ? { reason } : {}),
  };
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/** Normalise a core Estimate into the CLI's shape. */
export function toCliEstimate(raw: unknown): CliEstimate {
  const r = isRecord(raw) ? raw : {};
  const tier = isRecord(r.tier)
    ? (r.tier as unknown as core.Tier)
    : ({
        level: 0,
        score: 0,
        factors: { loc: 0, files: 0, modules: 0, criticalPathHits: [] },
        reasons: [],
      } satisfies core.Tier);
  const seatsRaw = Array.isArray(r.seats) ? r.seats.filter(isRecord) : [];
  const perSeat = isRecord(r.perSeatUsd) ? r.perSeatUsd : {};
  const seats = seatsRaw.map((s) => {
    const model = isRecord(s.model) ? s.model : {};
    const down = isRecord(s.downgradedFrom) ? s.downgradedFrom : undefined;
    const id = String(s.id ?? "");
    const usd = num(s.usd) ?? num(s.estimateUsd) ?? num(perSeat[id]);
    return {
      id,
      role: s.role === "judge" ? ("judge" as const) : ("hunter" as const),
      lens: String(s.lens ?? ""),
      connectionId: String(model.connectionId ?? ""),
      provider: String(model.provider ?? ""),
      model: String(model.name ?? ""),
      ...(usd !== undefined ? { usd } : {}),
      ...(down ? { downgradedFrom: `${String(down.connectionId)}/${String(down.name)}` } : {}),
    };
  });
  const ceilingsRaw = Array.isArray(r.ceilings) ? r.ceilings.filter(isRecord) : [];
  const admission = isRecord(r.admission) ? r.admission : {};
  const triage = isRecord(r.triage) ? r.triage : undefined;
  const usd = num(r.usd) ?? num(r.estimatedUsd) ?? num(r.totalUsd);
  return {
    tier,
    ...(triage && triage.decision === "auto-pass" ? { triaged: { reason: String(triage.reason ?? "") } } : {}),
    seats,
    ...(usd !== undefined ? { usd } : {}),
    unknownSeats: Array.isArray(r.unknownSeats) ? r.unknownSeats.map(String) : [],
    ceilings: ceilingsRaw.map((c) => ({
      ceiling: String(c.ceiling ?? ""),
      limitUsd: num(c.limitUsd) ?? null,
      currentUsd: num(c.currentUsd) ?? 0,
      projectedUsd: num(c.projectedUsd) ?? 0,
      breached: c.breached === true,
      ...(c.advisory === true ? { advisory: true } : {}),
    })),
    admitted: r.admitted === false ? false : admission.ok !== false,
    ...(typeof admission.message === "string" ? { blockedReason: admission.message } : {}),
    downgrades: Array.isArray(r.downgrades) ? (r.downgrades as core.DowngradeStep[]) : [],
    warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
  };
}

export function adaptGate(g: CoreGateLike, policy: core.Policy): CliGate {
  return {
    async review(ref, opts) {
      return toCliResult(await g.review(ref, opts.headSha ? { headSha: opts.headSha } : {}), policy);
    },
    async reviewChange(input: LocalReviewInput) {
      return toCliResult(await g.reviewChange(input.change, { diff: input.diff, untrusted: input.untrusted }), policy);
    },
    async estimate(target) {
      return toCliEstimate(await g.estimate(isChangeRef(target) ? target : target.change));
    },
    async explain(ref) {
      const raw = await g.explain(ref);
      if (raw === null || raw === undefined) return null;
      const r = isRecord(raw) ? raw : {};
      const verdict = isVerdict(r.verdict) ? r.verdict : isVerdict(raw) ? raw : undefined;
      if (!verdict) return null;
      return { verdict, digest: isDigest(r.digest) ? r.digest : core.renderDigest(verdict, { policy }) };
    },
    async recordHumanVerdict(input) {
      const raw = await g.recordHumanVerdict(input);
      const r = isRecord(raw) ? raw : {};
      const v = isVerdict(r.verdict) ? r.verdict : isVerdict(raw) ? raw : undefined;
      if (!v) throw new CliError("GATE_ERROR", "the gate did not return the recorded verdict");
      return v;
    },
  };
}

/** The production GateFactory. */
export function realGateFactory(registry: () => ProviderRegistry = defaultProviderRegistry): GateFactory {
  return async (setup) => {
    const createGate = resolveCreateGate();
    const { deps } = await buildGateDeps(setup, registry());
    return adaptGate(createGate(deps), setup.policy.policy);
  };
}
