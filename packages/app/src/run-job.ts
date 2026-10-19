/**
 * The per-job pipeline: installation client, policy from the PR's BASE branch, installation connections and
 * catalog, then the gate. The same preparation backs the explain and human-verdict endpoints.
 *
 * The policy is read from the base ref, never from the head SHA: a PR (especially from a fork, or delivered as
 * pull_request_target) must not be able to loosen its own review by editing `.merge-safely.yml`.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChangeRef,
  type CostLedger,
  type Policy,
  parsePolicy,
  policyHash,
  type Reporter,
  type ToolExecutorFactory,
  type VerdictStore,
  type Workspace,
} from "@merge-safely/core";
import { slackEscalation, slackReporter } from "@merge-safely/escalation-slack";
import {
  type ApiResponse,
  checkRunReporter,
  DEFAULT_CHECK_NAME,
  githubSource,
  type OctokitLike,
  prReviewReporter,
  redactSecrets,
  trustFromPolicy,
} from "@merge-safely/github";
import { catalogLookup, type ProviderRegistry, secretValues } from "@merge-safely/providers";
import { createReadOnlyTools } from "@merge-safely/tools";
import { type LocalWorkspaceOptions, localWorkspace } from "@merge-safely/workspace-local";
import { parse as parseYaml } from "yaml";
import type { CatalogCache } from "./catalog-cache.js";
import type { AppDb, JobRow } from "./db.js";
import type { Gate, GateFactory } from "./gate.js";
import type { AppLogger, SecretSet } from "./logger.js";
import { gateMetrics, type MetricsRegistry } from "./metrics.js";
import { applyBudgetOverrides, loadBudgetOverrides } from "./settings.js";
import { pricing, prompts } from "./wiring.js";

export const POLICY_PATH = ".merge-safely.yml";
export const PRODUCED_BY = "merge-safely-app/0.1.0";

/** The App's view of an installation client: the adapters' `OctokitLike` plus contents and token minting. */
export interface AppOctokit extends OctokitLike {
  repos: OctokitLike["repos"] & {
    getContent(params: { owner: string; repo: string; path: string; ref?: string }): Promise<ApiResponse<unknown>>;
  };
  /** Octokit's auth hook; `{ type: "installation" }` returns `{ token }` with auth-app. */
  auth(...args: unknown[]): Promise<unknown>;
}

export interface PipelineConfig {
  dataDir: string;
  publicUrl?: string;
  slackWebhookUrl?: string;
  /** Host of the GitHub instance ("github.com" or the GHES host). */
  githubHost: string;
  concurrency?: number;
}

export interface PipelineDeps {
  config: PipelineConfig;
  db: AppDb;
  store: VerdictStore;
  ledger: CostLedger;
  octokitFor(installationId: number): AppOctokit;
  gateFactory: GateFactory;
  registry: ProviderRegistry;
  catalogCache: CatalogCache;
  secrets: SecretSet;
  logger: AppLogger;
  metrics: MetricsRegistry;
  workspaceFactory?: (opts: LocalWorkspaceOptions) => Workspace;
  tools?: ToolExecutorFactory;
}

export function splitRepo(full: string): { owner: string; name: string } {
  const [owner, name, ...rest] = full.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`invalid repository "${full}" (expected owner/name)`);
  return { owner, name };
}

export type PolicyFetch =
  | { ok: true; policy: Policy; hash: string; source: "file" | "default" }
  | { ok: false; errors: string[] };

function hasStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === status;
}

/** Fetch and parse `.merge-safely.yml` at `ref`. A missing file means the default policy. */
export async function fetchPolicy(octokit: AppOctokit, owner: string, repo: string, ref: string): Promise<PolicyFetch> {
  let data: unknown;
  try {
    data = (await octokit.repos.getContent({ owner, repo, path: POLICY_PATH, ref })).data;
  } catch (err: unknown) {
    if (hasStatus(err, 404)) {
      const r = parsePolicy({});
      return r.ok ? { ok: true, policy: r.policy, hash: r.hash, source: "default" } : { ok: false, errors: r.errors };
    }
    throw err;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, errors: [`${POLICY_PATH} is not a file`] };
  }
  const file = data as { content?: unknown; encoding?: unknown; size?: unknown };
  if (typeof file.content !== "string" || (file.encoding !== undefined && file.encoding !== "base64")) {
    return { ok: false, errors: [`${POLICY_PATH} could not be read (too large or not base64 content)`] };
  }
  const text = Buffer.from(file.content, "base64").toString("utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err: unknown) {
    return {
      ok: false,
      errors: [`${POLICY_PATH} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const r = parsePolicy(doc ?? {});
  return r.ok ? { ok: true, policy: r.policy, hash: r.hash, source: "file" } : { ok: false, errors: r.errors };
}

export type Prepared =
  | {
      kind: "ready";
      gate: Gate;
      ref: ChangeRef;
      headSha: string;
      baseRef: string;
      policy: Policy;
      policyHash: string;
      policySource: "file" | "default";
      octokit: AppOctokit;
    }
  | { kind: "invalid-policy"; ref: ChangeRef; headSha: string; baseRef: string; errors: string[]; octokit: AppOctokit };

async function installationToken(octokit: AppOctokit): Promise<string | undefined> {
  const a = await octokit.auth({ type: "installation" });
  if (typeof a === "object" && a !== null && "token" in a && typeof (a as { token: unknown }).token === "string") {
    return (a as { token: string }).token;
  }
  return undefined;
}

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";

export const mirrorDir = (dataDir: string, installationId: number, owner?: string, name?: string): string =>
  owner && name
    ? join(dataDir, "repos", String(installationId), `${safeSegment(owner)}__${safeSegment(name)}.git`)
    : join(dataDir, "repos", String(installationId));
export const worktreeDir = (dataDir: string, installationId: number): string =>
  join(dataDir, "worktrees", String(installationId));

/**
 * Remove cloned source for an uninstalled installation (all of it) or for repositories removed from it. Best effort:
 * failures are logged, never thrown.
 */
export async function purgeInstallationFiles(
  dataDir: string,
  installationId: number,
  logger: AppLogger,
  repos?: string[],
): Promise<string[]> {
  const targets =
    repos === undefined
      ? [mirrorDir(dataDir, installationId), worktreeDir(dataDir, installationId)]
      : repos.map((r) => {
          const { owner, name } = splitRepo(r);
          return mirrorDir(dataDir, installationId, owner, name);
        });
  const removed: string[] = [];
  for (const t of targets) {
    try {
      await rm(t, { recursive: true, force: true });
      removed.push(t);
    } catch (err: unknown) {
      logger.warn("could not remove cloned source", {
        installationId,
        path: t,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (removed.length > 0) logger.info("removed cloned source", { installationId, paths: removed.length });
  return removed;
}

export interface PrepareOptions {
  /**
   * Read-only use (explain, human verdict): no installation token is minted, no clone is ever made, and the model
   * catalog is taken from the cache only (no provider calls).
   */
  light?: boolean;
}

/** Build everything a review of one PR needs. `headSha` empty or undefined means "the PR's current head". */
export async function prepare(
  deps: PipelineDeps,
  installationId: number,
  repoFull: string,
  number: number,
  headSha?: string,
  opts: PrepareOptions = {},
): Promise<Prepared> {
  const { owner, name } = splitRepo(repoFull);
  const ref: ChangeRef = { repo: { host: deps.config.githubHost, owner, name }, number };
  const octokit = deps.octokitFor(installationId);
  const pr = (await octokit.pulls.get({ owner, repo: name, pull_number: number })).data;
  const sha = headSha || pr.head.sha;
  const baseRef = pr.base.ref;

  const fetched = await fetchPolicy(octokit, owner, name, baseRef);
  if (!fetched.ok) return { kind: "invalid-policy", ref, headSha: sha, baseRef, errors: fetched.errors, octokit };

  const policy = applyBudgetOverrides(fetched.policy, loadBudgetOverrides(deps.db, installationId, deps.logger));
  const hash = policyHash(policy);

  const { connections, problems } = deps.db.loadConnections(installationId);
  for (const c of connections) deps.secrets.add(...secretValues(c.secret));
  for (const p of problems)
    deps.logger.error("connection unavailable", { installationId, connection: p.id, error: p.message });
  const catalog = opts.light
    ? (deps.catalogCache.peek(installationId) ?? { byConnection: new Map(), problems: [] })
    : await deps.catalogCache.get(installationId, connections);
  for (const p of catalog.problems) {
    deps.logger.warn("connection catalog problem", { installationId, connection: p.connectionId, error: p.message });
  }

  const token = opts.light ? undefined : await installationToken(octokit);
  deps.secrets.add(token);
  const wsOpts: LocalWorkspaceOptions = {
    cloneUrl: `https://${deps.config.githubHost}/${owner}/${name}.git`,
    cacheDir: mirrorDir(deps.config.dataDir, installationId, owner, name),
    worktreeRoot: worktreeDir(deps.config.dataDir, installationId),
  };
  if (token) wsOpts.token = token; // sent as an http.extraheader by the workspace, never in the URL
  const workspace = (deps.workspaceFactory ?? localWorkspace)(wsOpts);

  // No detailsUrl: the bearer-protected admin endpoint would 401 for anyone clicking "Details" on GitHub, so the
  // reporter's default (the PR) is used.
  const reporters: Reporter[] = [checkRunReporter({ octokit, policy })];
  if (policy.reporting.postPrReview) reporters.push(prReviewReporter({ octokit, policy }));
  const slack = deps.config.slackWebhookUrl;
  if (slack) reporters.push(slackReporter({ webhookUrl: slack, logger: deps.logger }));

  const resolveHint = (v: { headSha: string }) =>
    `POST ${deps.config.publicUrl ?? "<app>"}/installations/${installationId}/verdict with {"repo":"${owner}/${name}","number":${number},"headSha":"${v.headSha}","decision":"pass|block","reason":"…","signedBy":"<login>"}`;

  const gate = deps.gateFactory({
    source: githubSource({ octokit }),
    workspace,
    providers: (conn) => deps.registry.forConnection(conn),
    connections,
    catalog: catalogLookup(catalog),
    store: deps.store,
    reporters,
    ledger: deps.ledger,
    trust: trustFromPolicy(policy, octokit, deps.logger),
    ...(slack ? { escalation: slackEscalation({ webhookUrl: slack, resolveHint }) } : {}),
    metrics: gateMetrics(deps.metrics),
    policy,
    policyHash: hash,
    tools: deps.tools ?? createReadOnlyTools,
    prompts,
    pricing,
    installationId: String(installationId),
    logger: deps.logger.child({ installationId, repo: repoFull, number }),
    producedBy: PRODUCED_BY,
    ...(deps.config.concurrency ? { concurrency: deps.config.concurrency } : {}),
  });
  return {
    kind: "ready",
    gate,
    ref,
    headSha: sha,
    baseRef,
    policy,
    policyHash: hash,
    policySource: fetched.source,
    octokit,
  };
}

/** Write (or update) a failed `merge-safely/verdict` check run with a message. Used when the gate never ran. */
export async function failureCheckRun(
  octokit: AppOctokit,
  owner: string,
  repo: string,
  headSha: string,
  title: string,
  summary: string,
  checkName: string = DEFAULT_CHECK_NAME,
): Promise<void> {
  const output = { title, summary: redactSecrets(summary).slice(0, 60_000) };
  const existing = await octokit.checks.listForRef({ owner, repo, ref: headSha, check_name: checkName, per_page: 10 });
  const run = existing.data.check_runs.find((r) => r.name === checkName);
  const completed_at = new Date().toISOString();
  if (run) {
    await octokit.checks.update({
      owner,
      repo,
      check_run_id: run.id,
      status: "completed",
      conclusion: "failure",
      completed_at,
      output,
    });
  } else {
    await octokit.checks.create({
      owner,
      repo,
      name: checkName,
      head_sha: headSha,
      status: "completed",
      conclusion: "failure",
      completed_at,
      output,
    });
  }
}

export function policyFailureSummary(errors: string[], baseRef: string): string {
  const list = errors.map((e) => `- ${e.replace(/`/g, "'")}`).join("\n");
  return [
    `\`${POLICY_PATH}\` on the base branch \`${baseRef.replace(/`/g, "'")}\` is invalid, so no review ran and no model was called.`,
    "",
    list,
    "",
    "Fix the policy on the base branch (the policy is never read from the PR's head), then re-run this check.",
  ].join("\n");
}

export interface JobOutcome {
  outcome: string;
}

/** Run one job end to end. Throws on failure; the queue classifies the error for retry. */
export async function runJob(deps: PipelineDeps, job: JobRow): Promise<JobOutcome> {
  const prep = await prepare(deps, job.installation_id, job.repo, job.number, job.head_sha);
  const { owner, name } = splitRepo(job.repo);
  if (prep.kind === "invalid-policy") {
    deps.db.annotateJob(job.id, { baseRef: prep.baseRef, policySource: "invalid" });
    deps.logger.warn("invalid policy; failing the check without a review", {
      jobId: job.id,
      repo: job.repo,
      baseRef: prep.baseRef,
    });
    await failureCheckRun(
      prep.octokit,
      owner,
      name,
      prep.headSha,
      "Invalid .merge-safely.yml",
      policyFailureSummary(prep.errors, prep.baseRef),
    );
    deps.metrics.inc("merge_safely_verdicts_total", "Verdicts produced, by decision and tier", {
      decision: "invalid-policy",
      tier: "none",
    });
    return { outcome: "invalid-policy" };
  }
  deps.db.annotateJob(job.id, { baseRef: prep.baseRef, policyHash: prep.policyHash, policySource: prep.policySource });
  // A retarget passes trigger "base-changed" so the gate runs a fresh, full review under the new base's policy.
  const result = await prep.gate.review(prep.ref, { headSha: prep.headSha, trigger: job.trigger ?? job.event });
  const v = result.verdict;
  deps.metrics.inc("merge_safely_verdicts_total", "Verdicts produced, by decision and tier", {
    decision: v.decision,
    tier: String(v.tier.level),
  });
  return { outcome: `${v.decision}${result.contested ? " (contested)" : ""}` };
}
