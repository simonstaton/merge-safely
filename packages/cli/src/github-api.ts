import type { RepoRef } from "@merge-safely/core";
import { CliError } from "./errors.js";

/** The few GitHub calls the CLI makes itself (the adapters in @merge-safely/github make the rest). */
export interface GithubApi {
  getPull(repo: RepoRef, number: number): Promise<{ headSha: string; baseRef: string; baseSha: string }>;
  /** File text at `ref`, or null when it does not exist. */
  getFile(repo: RepoRef, path: string, ref: string): Promise<string | null>;
}

/** Structural subset of `@octokit/rest` used here. */
export interface OctokitRestSubset {
  pulls: {
    get(p: { owner: string; repo: string; pull_number: number }): Promise<{
      data: { head: { sha: string }; base: { ref: string; sha: string } };
    }>;
  };
  repos: {
    getContent(p: { owner: string; repo: string; path: string; ref?: string }): Promise<{ data: unknown }>;
  };
}

function status(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : undefined;
}

function ghError(what: string, err: unknown): CliError {
  const s = status(err);
  if (s === 401) return new CliError("GITHUB_AUTH", `${what}: GitHub rejected the token (401)`);
  if (s === 403) return new CliError("GITHUB_FORBIDDEN", `${what}: the token lacks permission (403)`);
  if (s === 404) return new CliError("GITHUB_NOT_FOUND", `${what}: not found (404), or the token cannot see it`);
  return new CliError("GITHUB_ERROR", `${what}: ${err instanceof Error ? err.message : String(err)}`);
}

export function githubApi(octokit: OctokitRestSubset): GithubApi {
  return {
    async getPull(repo, number) {
      try {
        const { data } = await octokit.pulls.get({ owner: repo.owner, repo: repo.name, pull_number: number });
        return { headSha: data.head.sha, baseRef: data.base.ref, baseSha: data.base.sha };
      } catch (err: unknown) {
        throw ghError(`pull request ${repo.owner}/${repo.name}#${number}`, err);
      }
    },
    async getFile(repo, path, ref) {
      let data: unknown;
      try {
        ({ data } = await octokit.repos.getContent({ owner: repo.owner, repo: repo.name, path, ref }));
      } catch (err: unknown) {
        if (status(err) === 404) return null;
        throw ghError(`${path} at ${ref}`, err);
      }
      if (typeof data !== "object" || data === null || Array.isArray(data) || !("content" in data)) {
        throw new CliError("POLICY_INVALID", `${path} at ${ref} is not a file`);
      }
      const content = data.content;
      const encoding = "encoding" in data ? data.encoding : "base64";
      if (typeof content !== "string") return null;
      return encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
    },
  };
}
