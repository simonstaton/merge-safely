/**
 * Which change this run is about, from GITHUB_EVENT_NAME and the event payload (GITHUB_EVENT_PATH).
 *
 * - pull_request / pull_request_target: opened, synchronize, reopened, ready_for_review (and `edited` with a base
 *   change). Drafts are skipped. `pull_request` from a fork is refused: its token is read-only and it has no secrets.
 * - workflow_dispatch: the `pr-number` input names the PR (re-run by hand, or from another workflow).
 * - check_run `rerequested`: the "Re-run" button on the verdict check (named per policy, from a trusted app).
 *   check_suite events are ignored.
 * - merge_group `checks_requested`: the merge-queue commit (see merge-group.ts).
 */
import type { ChangeRef, RepoRef } from "@merge-safely/core";
import { changeRefFromEvent, DEFAULT_HOST, parseRepo } from "@merge-safely/github";
import { actionError, ghExpr } from "./errors.js";
import type { ActionInputs } from "./inputs.js";

export type Trigger =
  | {
      kind: "review";
      event: string;
      ref: ChangeRef;
      /** The SHA the event was about (PR events, check events); undefined means "the PR's current head". */
      headSha?: string;
      /** PR head and base repositories differ, as far as the payload says (re-checked against the API). */
      forkHint?: boolean;
      /** check_run re-runs: the re-requested check, verified against the policy and trusted apps before acting. */
      checkRun?: { name: string; appSlug?: string };
    }
  | {
      kind: "merge-group";
      repo: RepoRef;
      /** The merge-queue commit the required check must be reported on. */
      headSha: string;
      /** Target branch name (without refs/heads/). */
      baseRef: string;
      prNumbers: number[];
    }
  | { kind: "skip"; message: string };

export const SUPPORTED_EVENTS = [
  "pull_request",
  "pull_request_target",
  "workflow_dispatch",
  "check_run",
  "check_suite",
  "merge_group",
] as const;

const SECURITY_DOCS = "https://github.com/simonstaton/merge-safely/blob/main/docs/security.md";

export const FORK_PULL_REQUEST_MESSAGE = [
  "This pull request comes from a fork. On the pull_request event GitHub gives fork PRs a read-only token and no",
  "secrets, so Merge Safely can neither reach a model nor write the verdict check run.",
  "To review fork PRs, run this workflow on pull_request_target instead. Merge Safely is built for that: it reads",
  "the policy from the base branch (a fork cannot loosen its own review), its reviewers only read the code and",
  "never execute it, and it refuses runner.allowedCommands on fork PRs. Do not add steps that build, install or",
  "run the checked-out PR code in that job, and use a model key with a low provider spend limit.",
  `Read ${SECURITY_DOCS}#fork-prs-and-pull_request_target first.`,
].join("\n");

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x !== "" ? x : undefined;
}

/** host from GITHUB_SERVER_URL (GHES), else github.com. */
export function serverHost(env: NodeJS.ProcessEnv): string {
  const url = env.GITHUB_SERVER_URL;
  if (!url) return DEFAULT_HOST;
  try {
    return new URL(url).host || DEFAULT_HOST;
  } catch (_err: unknown) {
    return DEFAULT_HOST;
  }
}

/** The repository from the payload, else GITHUB_REPOSITORY. */
export function repoOf(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): RepoRef {
  const host = serverHost(env);
  const r = payload.repository;
  if (isRecord(r)) {
    const full = str(r.full_name);
    if (full) return parseRepo(full, host);
    const owner = isRecord(r.owner) ? str(r.owner.login) : undefined;
    const name = str(r.name);
    if (owner && name) return { host, owner, name };
  }
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv) return parseRepo(fromEnv, host);
  throw actionError(
    "EVENT",
    "cannot tell which repository this run is for (no repository in the event, no GITHUB_REPOSITORY)",
  );
}

/**
 * True when the payload's PR head lives in another repository than its base. A deleted fork (head.repo null)
 * counts as a fork.
 */
export function isForkPullPayload(payload: Record<string, unknown>): boolean {
  const pr = payload.pull_request;
  if (!isRecord(pr)) return false;
  const head = isRecord(pr.head) ? pr.head : {};
  const base = isRecord(pr.base) ? pr.base : {};
  const headRepo = isRecord(head.repo) ? str(head.repo.full_name) : undefined;
  const baseRepo = isRecord(base.repo) ? str(base.repo.full_name) : undefined;
  if (!baseRepo) return false;
  return headRepo === undefined || headRepo.toLowerCase() !== baseRepo.toLowerCase();
}

/** `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>` -> n. */
export function prNumberFromQueueRef(ref: string): number | undefined {
  const m = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40,64}$/i.exec(ref);
  const n = m?.[1] ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function stripHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function resolveTrigger(
  name: string,
  payload: Record<string, unknown>,
  inputs: Pick<ActionInputs, "prNumber" | "headSha">,
  env: NodeJS.ProcessEnv,
): Trigger {
  if (inputs.prNumber !== undefined && name !== "workflow_dispatch") {
    throw actionError("INPUT", `pr-number is only used on workflow_dispatch (this run is ${name || "unknown"})`);
  }
  switch (name) {
    case "pull_request":
    case "pull_request_target": {
      const hit = changeRefFromEvent(name, payload);
      if (!hit) {
        return {
          kind: "skip",
          message: `${name}.${str(payload.action) ?? "?"} does not change the code under review; nothing to do`,
        };
      }
      if (hit.draft)
        return { kind: "skip", message: `PR #${hit.ref.number} is a draft; it is reviewed once it is ready` };
      const fork = isForkPullPayload(payload);
      if (name === "pull_request" && fork) throw actionError("FORK_PULL_REQUEST", FORK_PULL_REQUEST_MESSAGE);
      return {
        kind: "review",
        event: name,
        ref: hit.ref,
        ...(hit.headSha ? { headSha: hit.headSha } : {}),
        forkHint: fork,
      };
    }
    case "workflow_dispatch": {
      if (inputs.prNumber === undefined) {
        throw actionError(
          "INPUT",
          "workflow_dispatch needs the pr-number input, e.g.\n" +
            "on: { workflow_dispatch: { inputs: { pr: { required: true } } } }\n" +
            `with: { pr-number: ${ghExpr("inputs.pr")} }`,
        );
      }
      return { kind: "review", event: name, ref: { repo: repoOf(payload, env), number: inputs.prNumber } };
    }
    case "check_suite":
      // Never ours: GitHub does not trigger workflows for suites created by Actions, so a check_suite event here
      // is another app's suite (a third-party CI's "Re-run all"), which must not start a paid re-review.
      return { kind: "skip", message: "check_suite events are ignored; re-run with workflow_dispatch and pr-number" };
    case "check_run": {
      // Any name here; run.ts matches it exactly against the base-branch policy's reporting.checkName.
      const hit = changeRefFromEvent(name, payload, { checkNamePrefix: "" });
      const cr = isRecord(payload.check_run) ? payload.check_run : {};
      if (!hit) {
        return {
          kind: "skip",
          message:
            `check_run.${str(payload.action) ?? "?"} is not a re-run of a check on a same-repository PR; ` +
            "nothing to do (fork PRs: re-run with workflow_dispatch and pr-number)",
        };
      }
      const appSlug = isRecord(cr.app) ? str(cr.app.slug) : undefined;
      return {
        kind: "review",
        event: name,
        ref: hit.ref,
        ...(hit.headSha ? { headSha: hit.headSha } : {}),
        checkRun: { name: str(cr.name) ?? "", ...(appSlug ? { appSlug: appSlug.toLowerCase() } : {}) },
      };
    }
    case "merge_group": {
      if (payload.action !== "checks_requested") {
        return { kind: "skip", message: `merge_group.${str(payload.action) ?? "?"}: nothing to do` };
      }
      const mg = isRecord(payload.merge_group) ? payload.merge_group : {};
      const headSha = str(mg.head_sha);
      const headRef = str(mg.head_ref);
      const baseRef = str(mg.base_ref);
      if (!headSha || !headRef || !baseRef) {
        throw actionError("EVENT", "merge_group event without head_sha, head_ref and base_ref");
      }
      const n = prNumberFromQueueRef(headRef);
      if (n === undefined) throw actionError("EVENT", `cannot find the PR number in merge-queue ref ${headRef}`);
      return { kind: "merge-group", repo: repoOf(payload, env), headSha, baseRef: stripHeads(baseRef), prNumbers: [n] };
    }
    default:
      throw actionError(
        "EVENT",
        `unsupported event "${name || "(none)"}". Run Merge Safely on: ${SUPPORTED_EVENTS.join(", ")}`,
      );
  }
}
