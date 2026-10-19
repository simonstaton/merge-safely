import type { OctokitLike, PullRequestData } from "@merge-safely/github";
import { describe, expect, it } from "vitest";
import { materializeCase, syntheticSha } from "./materialize.js";
import { parseCase } from "./suite.js";

const DIFF_AT_INCIDENT = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -1 +1 @@",
  "-export const check = (ok: boolean) => ok;",
  "+export const check = (_ok: boolean) => true;",
  "",
].join("\n");

function fakeOctokit(headNow: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const pr: PullRequestData = {
    number: 12,
    title: "Tweak login",
    body: "safe",
    html_url: "https://github.com/acme/web/pull/12",
    draft: false,
    user: { login: "alice", id: 1, type: "User" },
    labels: [],
    head: { sha: headNow, ref: "feature", repo: { full_name: "acme/web" } },
    base: { sha: "base000", ref: "main", repo: { full_name: "acme/web" } },
    additions: 50,
    deletions: 3,
    changed_files: 4,
  };
  const rec =
    <T>(method: string, data: T) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { data };
    };
  const octokit = {
    pulls: {
      get: rec("pulls.get", pr),
      listFiles: rec("pulls.listFiles", [
        { filename: "src/later.ts", status: "modified", additions: 50, deletions: 3 },
      ]),
      listCommits: rec("pulls.listCommits", [{ sha: "c1", commit: { message: "tweak" } }]),
      listReviewComments: rec("pulls.listReviewComments", []),
    },
    issues: { listComments: rec("issues.listComments", []) },
    repos: {
      getCombinedStatusForRef: rec("repos.getCombinedStatusForRef", { statuses: [] }),
      compareCommitsWithBasehead: rec("repos.compareCommitsWithBasehead", DIFF_AT_INCIDENT),
    },
    checks: { listForRef: rec("checks.listForRef", { check_runs: [] }) },
  };
  return { octokit: octokit as unknown as OctokitLike, calls };
}

const ghCase = (headSha?: string) => ({
  dir: "/nonexistent",
  spec: parseCase({
    id: "gh",
    title: "gh",
    kind: "incident",
    expected: { decision: "block" },
    source: { type: "github", repo: "acme/web", pr: 12, ...(headSha ? { headSha } : {}) },
  }),
});

describe("materializeCase (github)", () => {
  it("pins to the incident SHA and derives files from the pinned diff when the PR moved", async () => {
    const { octokit, calls } = fakeOctokit("moved999");
    const m = await materializeCase(ghCase("abc1234"), 0, { github: { octokit } });
    expect(m.change.headSha).toBe("abc1234");
    expect(m.change.repo).toEqual({ host: "github.com", owner: "acme", name: "web" });
    expect(m.change.files).toEqual([
      expect.objectContaining({ path: "src/auth/login.ts", additions: 1, deletions: 1 }),
    ]);
    expect(m.change.stats).toEqual({ additions: 1, deletions: 1, files: 1 });
    expect(m.diff).toBe(DIFF_AT_INCIDENT);
    expect(m.untrusted.commitMessages).toEqual(["tweak"]);
    const compare = calls.find((c) => c.method === "repos.compareCommitsWithBasehead");
    expect(compare?.params.basehead).toBe("base000...abc1234");
  });

  it("uses the PR's own file list when it is still at the pinned head", async () => {
    const { octokit } = fakeOctokit("abc1234");
    const m = await materializeCase(ghCase(), 0, { github: { octokit } });
    expect(m.change.files.map((f) => f.path)).toEqual(["src/later.ts"]);
  });

  it("requires a token", async () => {
    await expect(materializeCase(ghCase(), 0)).rejects.toThrow(/token required/);
  });
});

describe("syntheticSha", () => {
  it("is 40 hex chars and stable", () => {
    expect(syntheticSha("a")).toMatch(/^[0-9a-f]{40}$/);
    expect(syntheticSha("a")).toBe(syntheticSha("a"));
    expect(syntheticSha("a")).not.toBe(syntheticSha("b"));
  });
});
