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
import { runMergeGroup } from "./merge-group.js";
import { type ActionOutputs, reviewOutputs, reviewSummary } from "./outputs.js";
import { hardenForFork, loadActionPolicy } from "./policy.js";

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
  /** Store holding PR verdicts, for merge-queue lookups. Default: the check-run store. */
  verdictStore?(octokit: OctokitLike, policy: Policy, logger: Logger): VerdictStore;
  now?(): Date;
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

function setOutputs(core: ActionCore, outputs: Partial<ActionOutputs>): void {
  for (const [k, v] of Object.entries(outputs)) core.setOutput(k, v ?? "");
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
    setOutputs(core, { decision: "skipped" });
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
    const store = (deps.verdictStore ?? ((octokit, p, l) => checkRunStore({ octokit, policy: p, logger: l })))(
      gh.octokit,
      policy.policy,
      logger,
    );
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
    setOutputs(core, {
      decision: r.ok ? "pass" : "block",
      "check-url": checkUrl,
      "verdict-json": JSON.stringify({ mergeGroup: trigger.headSha, ok: r.ok, prs: r.entries }),
    });
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
  const headSha = inputs.headSha ?? trigger.headSha ?? pull.head.sha;
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
    ...(inputs.slackWebhook ? { slackWebhook: inputs.slackWebhook } : {}),
  });
  const result = await gate.review(ref, { headSha });
  const checkUrl = await findCheckUrl(gh.octokit, ref.repo, headSha, policy.policy, env, logger);
  setOutputs(core, reviewOutputs(result, checkUrl));
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
    deps.core.setFailed(`error [${errorCode(err)}]: ${secrets.scrub(msg)}`);
    // Expected failures (CliError: configuration, events, GitHub refusals) carry the whole story in the message.
    if (!(err instanceof CliError) && err instanceof Error && err.stack) deps.core.debug(secrets.scrub(err.stack));
    const code = isRecord(err) && typeof err.exitCode === "number" ? err.exitCode : EXIT.error;
    return code === EXIT.pass ? EXIT.error : code;
  }
}
