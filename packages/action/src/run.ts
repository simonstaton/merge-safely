/**
 * The Action's run flow, with every effect injected (`RunDeps`) so tests drive it with fakes:
 * inputs -> event -> (merge queue | review) -> outputs, job summary and the job's pass/fail.
 *
 * Exit codes mirror the CLI: 0 pass, 1 block, 2 pending / contested / error / configuration, 3 budget-blocked.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliError,
  type CliReviewResult,
  EXIT,
  errorCode,
  exitFor,
  type GateFactory,
  homePaths,
  SecretSet,
} from "@merge-safely/cli";
import type { Logger, Policy, RepoRef, VerdictStore } from "@merge-safely/core";
import { checkRunStore, findCheckRun, type OctokitLike, resolveCheckName, resolveIdentity } from "@merge-safely/github";
import { CONNECTIONS_REQUIRED, parseConnections } from "./connections.js";
import { actionError, ghExpr } from "./errors.js";
import { resolveTrigger } from "./event.js";
import { type ActionInputs, readInputs } from "./inputs.js";
import { anyOfStores, runMergeGroup } from "./merge-group.js";
import { type ActionOutputs, reviewOutputs, reviewSummary } from "./outputs.js";
import { hardenForFork, loadActionPolicy } from "./policy.js";
import { ACTION_VERSION } from "./version.js";

/** The slice of @actions/core the Action uses. */
export interface ActionCore {
  getInput(name: string): string;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  setSecret(secret: string): void;
  debug(msg: string): void;
  info(msg: string): void;
  notice(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
  /** Append markdown to the job summary (GITHUB_STEP_SUMMARY). */
  writeSummary(markdown: string): Promise<void>;
}

export interface ActionGithub {
  octokit: OctokitLike;
  /** File text at `ref`, or null when it does not exist. */
  getFile(repo: RepoRef, path: string, ref: string): Promise<string | null>;
}

export interface RunDeps {
  core: ActionCore;
  env: NodeJS.ProcessEnv;
  /** Local file text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  github(token: string): ActionGithub;
  gateFactory: GateFactory;
  /** Store holding PR verdicts written by any of `appSlugs`, for merge-queue lookups. Default: check-run stores. */
  verdictStore?(octokit: OctokitLike, policy: Policy, logger: Logger, appSlugs: string[]): VerdictStore;
  now?(): Date;
  /** Register a handler for job cancellation (SIGINT/SIGTERM): closes out the pending check run. */
  onCancel?(fn: () => Promise<void>): void;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function actionLogger(core: ActionCore, secrets: SecretSet): Logger {
  const fmt = (msg: string, meta?: Record<string, unknown>): string => {
    let line = msg;
    if (meta && Object.keys(meta).length > 0) {
      try {
        line = `${msg} ${JSON.stringify(meta)}`;
      } catch (_err: unknown) {
        line = msg;
      }
    }
    return secrets.scrub(line);
  };
  return {
    debug: (m, meta) => core.debug(fmt(m, meta)),
    info: (m, meta) => core.info(fmt(m, meta)),
    warn: (m, meta) => core.warning(fmt(m, meta)),
    error: (m, meta) => core.error(fmt(m, meta)),
  };
}

/** Outputs can carry model-written text (finding titles in verdict-json): scrub them like the summary. */
function setOutputs(core: ActionCore, outputs: Partial<ActionOutputs>, secrets: SecretSet): void {
  for (const [k, v] of Object.entries(outputs)) core.setOutput(k, v ? secrets.scrub(v) : "");
}

/** Our own app (GET /app works for App JWT-backed clients; the workflow token falls back to github-actions). */
async function trustedSlugs(octokit: OctokitLike, configured: string[], logger: Logger): Promise<string[]> {
  let own: string | undefined;
  try {
    own = (await resolveIdentity(octokit, {}, logger)).appSlug.toLowerCase();
  } catch (_err: unknown) {
    own = undefined;
  }
  return [...new Set([...configured, ...(own ? [own] : [])])];
}

/** Ceilings a single job cannot enforce: they need spend across jobs, which only the App's ledger sees. */
export const ACTION_ADVISORY_CEILINGS = ["window", "all-time", "monthly"] as const;

export function advisoryCeilingWarning(policy: Policy): string | undefined {
  const b = policy.budget;
  const set = [
    b.windowUsd !== null ? "budget.windowUsd" : undefined,
    b.spendLimitUsd !== null ? "budget.spendLimitUsd" : undefined,
    b.perInstallationMonthlyUsd !== null ? "budget.perInstallationMonthlyUsd" : undefined,
  ].filter((x): x is string => x !== undefined);
  if (set.length === 0) return undefined;
  return (
    `${set.join(", ")} ${set.length === 1 ? "is" : "are"} not enforceable in the Action: spend across jobs is not ` +
    "visible to a single job, so these ceilings are reported as advisory only; use the App for enforced " +
    "installation-wide budgets. budget.perSeatUsd and budget.perChangeUsd are enforced."
  );
}

function isHeadMoved(err: unknown): boolean {
  return isRecord(err) && err.code === "head-moved";
}

async function readEvent(deps: RunDeps): Promise<Record<string, unknown>> {
  const path = deps.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  const text = await deps.readFile(path);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch (_err: unknown) {
    throw actionError("EVENT", `the event payload at GITHUB_EVENT_PATH is not valid JSON`);
  }
}

function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
}

function serverUrl(env: NodeJS.ProcessEnv, repo: RepoRef): string {
  return (env.GITHUB_SERVER_URL ?? `https://${repo.host}`).replace(/\/+$/, "");
}

async function findCheckUrl(
  octokit: OctokitLike,
  repo: RepoRef,
  headSha: string,
  policy: Policy,
  env: NodeJS.ProcessEnv,
  logger: Logger,
): Promise<string | undefined> {
  try {
    const who = await resolveIdentity(octokit, {}, logger);
    const run = await findCheckRun(octokit, repo, headSha, resolveCheckName(undefined, policy), who);
    return run ? `${serverUrl(env, repo)}/${repo.owner}/${repo.name}/runs/${run.id}` : undefined;
  } catch (_err: unknown) {
    logger.debug("could not look up the verdict check run URL");
    return undefined;
  }
}

/** Classic and fine-grained PATs, OAuth and user-to-server tokens: none can write check runs. */
const PERSONAL_TOKEN = /^(ghp_|github_pat_|gho_|ghu_)/;

const PERMISSIONS_HINT = "permissions: { checks: write, pull-requests: write, contents: read }";

function httpStatus(err: unknown): number | undefined {
  return isRecord(err) && typeof err.status === "number" ? err.status : undefined;
}

/** Run a GitHub call, turning auth/permission/not-found failures into a message with the fix. */
async function github<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const s = httpStatus(err);
    if (s === 401) throw actionError("GITHUB_AUTH", `${what}: GitHub rejected github-token (401)`);
    if (s === 403) {
      throw actionError(
        "GITHUB_FORBIDDEN",
        `${what}: github-token lacks permission (403). Give the job ${PERMISSIONS_HINT}`,
      );
    }
    if (s === 404) throw actionError("GITHUB_NOT_FOUND", `${what}: not found (404), or github-token cannot see it`);
    throw err;
  }
}

/** Fail (or not) the job for an outcome. Returns the exit code. */
export function conclude(
  core: ActionCore,
  r: CliReviewResult,
  inputs: Pick<ActionInputs, "failOnBlock" | "policyPath">,
) {
  const headline = r.digest.headline;
  switch (r.outcome) {
    case "pass":
      core.info(`Merge Safely: ${headline}`);
      return EXIT.pass;
    case "block":
      if (!inputs.failOnBlock) {
        core.warning(`Merge Safely blocked this change (fail-on-block is false, so the job passes): ${headline}`);
        return EXIT.pass;
      }
      core.setFailed(
        `Merge Safely blocked this change: ${headline}. Address the findings in the check run and PR review, then push.`,
      );
      return EXIT.block;
    case "budget-blocked":
      core.setFailed(
        `Merge Safely stopped at a budget ceiling: ${r.reason ?? headline}. Raise the ceiling it names (budget.* in ` +
          `${inputs.policyPath} on the base branch), then re-run this check.`,
      );
      return EXIT.budgetBlocked;
    case "contested":
      core.setFailed(
        `Merge Safely verdict is contested: ${r.reason ?? headline}. A pass conflicts with an unresolved block on this ` +
          "commit; a maintainer must resolve it (merge-safely verdict --decision pass|block).",
      );
      return exitFor(r.outcome);
    case "pending":
      core.setFailed(
        `Merge Safely verdict is pending: ${r.reason ?? headline}. It needs a human decision or a re-run.`,
      );
      return exitFor(r.outcome);
    default:
      core.setFailed(`Merge Safely could not complete the review: ${r.reason ?? headline}`);
      return exitFor(r.outcome);
  }
}

/** The PR moved past the commit this run was for. Not a failure: the newer push has its own run. */
function standDown(core: ActionCore, secrets: SecretSet, liveHead: string, pinned: string): number {
  core.notice(`Merge Safely: ${pinned.slice(0, 7)} was superseded by ${liveHead}; that push gets its own review`);
  setOutputs(core, { decision: "skipped" }, secrets);
  return EXIT.pass;
}

async function main(deps: RunDeps, secrets: SecretSet, logger: Logger): Promise<number> {
  const { core, env } = deps;
  const inputs = readInputs(core.getInput);
  const mask = (s: string) => {
    if (s.trim() === "") return;
    core.setSecret(s);
    secrets.add(s);
  };
  mask(inputs.githubToken);
  if (inputs.slackWebhook) mask(inputs.slackWebhook);

  const eventName = env.GITHUB_EVENT_NAME ?? "";
  // The merge-queue check reads stored verdicts only; it needs no model connection.
  if (eventName !== "merge_group" && inputs.connections.trim() === "") {
    throw actionError("INPUT", CONNECTIONS_REQUIRED);
  }
  const payload = await readEvent(deps);
  const trigger = resolveTrigger(eventName, payload, inputs, env);
  if (trigger.kind === "skip") {
    core.notice(`Merge Safely: ${trigger.message}`);
    setOutputs(core, { decision: "skipped" }, secrets);
    return EXIT.pass;
  }
  if (!inputs.githubToken) {
    throw actionError(
      "INPUT",
      `github-token is empty. Leave it at its default (${ghExpr("github.token")}) and grant the job ` +
        PERMISSIONS_HINT,
    );
  }
  const gh = deps.github(inputs.githubToken);
  const sources = {
    getFile: (repo: RepoRef, path: string, ref: string) => gh.getFile(repo, path, ref),
    readLocal: (path: string) => deps.readFile(path),
  };
  const policyLog = { info: (m: string) => core.info(m), warn: (m: string) => core.warning(m) };

  if (trigger.kind === "merge-group") {
    // Policy from the target branch: the queue commit is about to become it.
    const policy = await loadActionPolicy({
      repo: trigger.repo,
      baseRef: trigger.baseRef,
      path: inputs.policyPath,
      explicit: false,
      fork: true,
      sources,
      ...policyLog,
    });
    const slugs = await trustedSlugs(gh.octokit, inputs.verdictAppSlugs, logger);
    core.info(`merge queue: verdicts from ${slugs.join(", ")} count`);
    const store = (
      deps.verdictStore ??
      ((octokit, p, l, appSlugs) =>
        anyOfStores(appSlugs.map((appSlug) => checkRunStore({ octokit, policy: p, logger: l, appSlug }))))
    )(gh.octokit, policy.policy, logger, slugs);
    const detailsUrl = workflowRunUrl(env);
    const r = await github("merge queue check", () =>
      runMergeGroup({
        octokit: gh.octokit,
        store,
        policy: policy.policy,
        repo: trigger.repo,
        headSha: trigger.headSha,
        prNumbers: trigger.prNumbers,
        logger,
        ...(detailsUrl ? { detailsUrl } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      }),
    );
    const checkUrl =
      r.checkRunId !== undefined
        ? `${serverUrl(env, trigger.repo)}/${trigger.repo.owner}/${trigger.repo.name}/runs/${r.checkRunId}`
        : "";
    setOutputs(
      core,
      {
        decision: r.ok ? "pass" : "block",
        "check-url": checkUrl,
        "verdict-json": JSON.stringify({ mergeGroup: trigger.headSha, ok: r.ok, prs: r.entries }),
      },
      secrets,
    );
    await core.writeSummary(`## ${r.title}\n\n${r.summary}\n`);
    if (r.ok) return EXIT.pass;
    if (!inputs.failOnBlock) {
      core.warning(`${r.title} (fail-on-block is false, so the job passes; the check run still fails)`);
      return EXIT.pass;
    }
    core.setFailed(r.title);
    return EXIT.block;
  }

  // Review.
  const { ref } = trigger;
  const { data: pull } = await github(`pull request #${ref.number}`, () =>
    gh.octokit.pulls.get({ owner: ref.repo.owner, repo: ref.repo.name, pull_number: ref.number }),
  );
  const fork =
    trigger.forkHint === true ||
    !pull.head.repo ||
    pull.head.repo.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase();
  if (fork && trigger.event === "pull_request") {
    // Defensive: the payload check normally catches this first.
    throw actionError("FORK_PULL_REQUEST", "this pull request comes from a fork; see pull_request_target in the docs");
  }
  const pinned = inputs.headSha ?? trigger.headSha;
  if (pinned && pinned.toLowerCase() !== pull.head.sha.toLowerCase()) {
    if (trigger.event === "workflow_dispatch" && inputs.headSha) {
      throw actionError(
        "HEAD_MOVED",
        `head-sha ${inputs.headSha} is not the head of PR #${ref.number} (now ${pull.head.sha}). Verdicts are bound to ` +
          "the PR head, so only the current head can be reviewed; leave head-sha empty to review it",
      );
    }
    return standDown(core, secrets, pull.head.sha, pinned);
  }
  const headSha = pull.head.sha;
  core.info(`Merge Safely: reviewing ${ref.repo.owner}/${ref.repo.name}#${ref.number} at ${headSha}`);
  if (fork) core.info("fork PR: policy from the base branch, runner commands disabled");

  const workspace = env.GITHUB_WORKSPACE;
  const loaded = await loadActionPolicy({
    repo: ref.repo,
    baseRef: pull.base.ref,
    path: inputs.policyPath,
    explicit: inputs.policyExplicit,
    fork,
    ...(workspace ? { workspace } : {}),
    sources,
    ...policyLog,
  });
  const policy = hardenForFork(loaded, fork, (m) => core.warning(m));

  if (trigger.checkRun) {
    const want = policy.policy.reporting.checkName;
    if (trigger.checkRun.name !== want) {
      core.notice(`Merge Safely: check_run "${trigger.checkRun.name}" is not ${want}; nothing to do`);
      setOutputs(core, { decision: "skipped" }, secrets);
      return EXIT.pass;
    }
    const slugs = await trustedSlugs(gh.octokit, inputs.verdictAppSlugs, logger);
    if (!trigger.checkRun.appSlug || !slugs.includes(trigger.checkRun.appSlug)) {
      core.notice(
        `Merge Safely: ${want} re-run requested on a check from ${trigger.checkRun.appSlug ?? "an unknown app"}, ` +
          `not a trusted app (${slugs.join(", ")}); nothing to do`,
      );
      setOutputs(core, { decision: "skipped" }, secrets);
      return EXIT.pass;
    }
  }
  const ceilingWarning = advisoryCeilingWarning(policy.policy);
  if (ceilingWarning) core.warning(ceilingWarning);

  const connections = parseConnections(inputs.connections, env, mask, secrets);
  core.info(`connections: ${connections.map((c) => `${c.id} (${c.provider})`).join(", ")}`);

  // The default is the workflow token, an App installation token. A personal token is recognisable by its prefix.
  const identity = PERSONAL_TOKEN.test(inputs.githubToken) ? "user" : "app";
  if (identity === "user") {
    core.warning(
      "github-token looks like a personal token; the Checks API only accepts the workflow token or a GitHub App " +
        "token, so the verdict check run cannot be written. Leave github-token at its default.",
    );
  }
  const gate = await deps.gateFactory({
    target: {
      mode: "pr",
      repo: ref.repo,
      token: inputs.githubToken,
      tokenIdentity: identity,
      report: "github",
      store: "checkrun",
      dryRun: false,
    },
    policy,
    connections,
    paths: homePaths(join(env.RUNNER_TEMP || tmpdir(), "merge-safely")),
    logger,
    concurrency: inputs.concurrency,
    // Design 7.4: validate each key on the run and fail with the connection id and the fix before seating anyone.
    validateConnections: true,
    advisoryCeilings: [...ACTION_ADVISORY_CEILINGS],
    producedBy: `merge-safely-action@${ACTION_VERSION}`,
    ...(inputs.slackWebhook ? { slackWebhook: inputs.slackWebhook } : {}),
  });
  deps.onCancel?.(async () => {
    await gate.abort?.("the workflow run was cancelled");
  });
  let result: CliReviewResult;
  try {
    result = await gate.review(ref, { headSha, trigger: `action:${trigger.event}` });
  } catch (err: unknown) {
    // A push landed while this job ran: the newer head has its own run.
    if (!isHeadMoved(err)) throw err;
    const { data: now } = await github(`pull request #${ref.number}`, () =>
      gh.octokit.pulls.get({ owner: ref.repo.owner, repo: ref.repo.name, pull_number: ref.number }),
    );
    return standDown(core, secrets, now.head.sha, headSha);
  }
  const checkUrl = await findCheckUrl(gh.octokit, ref.repo, headSha, policy.policy, env, logger);
  setOutputs(core, reviewOutputs(result, checkUrl), secrets);
  await core.writeSummary(secrets.scrub(reviewSummary(result, checkUrl)));
  return conclude(core, result, inputs);
}

/** Run the Action. Never throws: every failure becomes `setFailed` with a one-paragraph message, no stack. */
export async function run(deps: RunDeps): Promise<number> {
  const secrets = new SecretSet();
  const logger = actionLogger(deps.core, secrets);
  try {
    return await main(deps, secrets, logger);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code0 = isRecord(err) && typeof err.exitCode === "number" ? err.exitCode : EXIT.error;
    deps.core.setOutput("decision", code0 === EXIT.budgetBlocked ? "budget-blocked" : "error");
    deps.core.setFailed(`error [${errorCode(err)}]: ${secrets.scrub(msg)}`);
    // Expected failures (CliError: configuration, events, GitHub refusals) carry the whole story in the message.
    if (!(err instanceof CliError) && err instanceof Error && err.stack) deps.core.debug(secrets.scrub(err.stack));
    return code0 === EXIT.pass ? EXIT.error : code0;
  }
}
