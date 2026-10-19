/**
 * Policy for an Action run.
 *
 * The policy is read from the PR's BASE branch through the API, never from the checked-out head: a pull request
 * must not be able to loosen its own review (lower quorum, widen runner.allowedCommands, drop critical paths).
 * A missing file means the defaults. An invalid file fails the run with every schema error.
 *
 * The `policy` input names the path in the repository (default `.merge-safely.yml`). As an escape hatch it may
 * instead name a file in the runner's checkout (`GITHUB_WORKSPACE`), e.g. a policy kept in a separate config repo
 * checked out by an earlier step. That is honoured only when the input is set explicitly, the file is inside the
 * workspace, and the PR is not from a fork: on a fork PR the checkout may be attacker-controlled, so the base
 * branch copy is used instead. Same-repository PR authors can already edit workflows, so the escape hatch does not
 * widen what they can do; still, check out a trusted ref (not the PR head) if you rely on it.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { GateSetup } from "@merge-safely/cli";
import { policyFromText } from "@merge-safely/cli";
import { DEFAULT_POLICY, policyHash, type RepoRef } from "@merge-safely/core";

export type LoadedPolicy = GateSetup["policy"];

export interface PolicySources {
  /** File text at `ref` via the GitHub API, or null when it does not exist. */
  getFile(repo: RepoRef, path: string, ref: string): Promise<string | null>;
  /** Local file text, or null when it does not exist. */
  readLocal(path: string): Promise<string | null>;
}

export interface LoadPolicyOptions {
  repo: RepoRef;
  baseRef: string;
  path: string;
  explicit: boolean;
  fork: boolean;
  /** GITHUB_WORKSPACE, when set. */
  workspace?: string;
  sources: PolicySources;
  info(msg: string): void;
  warn(msg: string): void;
}

export function defaultPolicy(): LoadedPolicy {
  return { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" };
}

function insideWorkspace(workspace: string, path: string): string | undefined {
  const abs = resolve(workspace, path);
  const rel = relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return abs;
}

export async function loadActionPolicy(o: LoadPolicyOptions): Promise<LoadedPolicy> {
  if (o.explicit && o.workspace) {
    const abs = insideWorkspace(o.workspace, o.path);
    const text = abs ? await o.sources.readLocal(abs) : null;
    if (text !== null) {
      if (o.fork) {
        o.warn(
          `ignoring ${o.path} in the runner checkout: this PR is from a fork, so the checkout may be the fork's code; ` +
            `reading ${o.path} from ${o.baseRef} instead`,
        );
      } else {
        const p = policyFromText(text, `checkout:${o.path}`);
        o.info(`policy: ${p.source} (${p.hash}) from the runner checkout (policy input)`);
        return p;
      }
    }
  }
  const text = await o.sources.getFile(o.repo, o.path, o.baseRef);
  if (text === null) {
    o.info(`policy: no ${o.path} on ${o.baseRef}; using the defaults`);
    return defaultPolicy();
  }
  const p = policyFromText(text, `${o.repo.owner}/${o.repo.name}@${o.baseRef}:${o.path}`);
  o.info(`policy: ${p.source} (${p.hash})`);
  return p;
}

/**
 * On a fork PR, never run commands from the policy: with `pull_request_target` the job holds secrets and a write
 * token, and an allowed command executes the fork's code next to them. Returns the policy with
 * `runner.allowedCommands` emptied (and re-hashed, so the verdict records the rules it actually ran under).
 */
export function hardenForFork(p: LoadedPolicy, fork: boolean, warn: (msg: string) => void): LoadedPolicy {
  const cmds = p.policy.runner.allowedCommands;
  if (!fork || cmds.length === 0) return p;
  warn(
    `SECURITY: runner.allowedCommands is set (${cmds.length} command${cmds.length === 1 ? "" : "s"}) but this PR ` +
      "comes from a fork. Running them would execute the fork's code next to this job's secrets and write token, " +
      "so they are disabled for this run (allowedCommands: []). Reviewers still read the code.",
  );
  const policy = { ...p.policy, runner: { ...p.policy.runner, allowedCommands: [] } };
  return { policy, hash: policyHash(policy), source: `${p.source} (allowedCommands disabled: fork PR)` };
}
