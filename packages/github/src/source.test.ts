import type { ChangeRef } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { basePr, callsTo, fakeOctokit, httpError } from "../test/fake-octokit.js";
import type { CheckRunData } from "./octokit.js";
import { aggregateCi, classifyAuthor, diffFromFiles, githubSource, parseLinkedTicket } from "./source.js";

const repo = { host: "github.com", owner: "acme", name: "widgets" };
const ref: ChangeRef = { repo, number: 7 };

function run(name: string, status: string, conclusion: string | null): CheckRunData & { annotations: [] } {
  return {
    id: Math.floor(Math.random() * 1e6),
    name,
    head_sha: "head1",
    status,
    conclusion,
    started_at: null,
    completed_at: null,
    output: { title: null, summary: null, text: null },
    annotations: [],
  };
}

describe("classifyAuthor", () => {
  it("detects bots by type and [bot] suffix", () => {
    expect(classifyAuthor({ login: "renovate", id: 2, type: "Bot" }, [], "").kind).toBe("bot");
    expect(classifyAuthor({ login: "dependabot[bot]", id: 3 }, [], "").kind).toBe("bot");
  });

  it("detects agents by label or AI co-author trailer", () => {
    expect(classifyAuthor({ login: "alice", id: 1, type: "User" }, ["AI-Authored"], "").kind).toBe("agent");
    expect(classifyAuthor({ login: "alice", id: 1, type: "User" }, ["agent"], "").kind).toBe("agent");
    expect(
      classifyAuthor({ login: "alice", id: 1, type: "User" }, [], "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
        .kind,
    ).toBe("agent");
    expect(
      classifyAuthor({ login: "alice", id: 1, type: "User" }, [], "Co-authored-by: Bob <bob@example.com>").kind,
    ).toBe("human");
  });

  it("handles a deleted user", () => {
    expect(classifyAuthor(null, [], "")).toEqual({ kind: "human", login: "ghost", id: undefined });
  });
});

describe("parseLinkedTicket", () => {
  it("parses GitHub closing keywords", () => {
    expect(parseLinkedTicket("This Fixes #123.", repo)).toEqual({
      provider: "github-issue",
      id: "acme/widgets#123",
      url: "https://github.com/acme/widgets/issues/123",
    });
    expect(parseLinkedTicket("closes org/repo#12", repo)?.id).toBe("org/repo#12");
  });

  it("parses Linear and Jira URLs", () => {
    expect(parseLinkedTicket("see https://linear.app/acme/issue/ENG-42/fix-thing", repo)).toMatchObject({
      provider: "linear",
      id: "ENG-42",
    });
    expect(parseLinkedTicket("https://acme.atlassian.net/browse/OPS-7", repo)).toMatchObject({
      provider: "jira",
      id: "OPS-7",
    });
  });

  it("returns undefined when nothing links", () => {
    expect(parseLinkedTicket("mentions #5 but does not close it", repo)).toBeUndefined();
  });
});

describe("aggregateCi", () => {
  it("applies failure > pending > success, unknown when empty", () => {
    expect(aggregateCi([])).toBe("unknown");
    expect(aggregateCi(["success", "success"])).toBe("success");
    expect(aggregateCi(["success", "pending"])).toBe("pending");
    expect(aggregateCi(["pending", "failure"])).toBe("failure");
  });
});

describe("githubSource.getChange", () => {
  it("maps a PR into a Change", async () => {
    const { octokit } = fakeOctokit({
      pr: basePr({ labels: [{ name: "backend" }], body: "Fixes #9", draft: true }),
      statuses: [{ context: "ci/build", state: "success" }],
      checkRuns: [run("tests", "completed", "success")],
    });
    const change = await githubSource({ octokit }).getChange(ref);
    expect(change).toMatchObject({
      repo,
      number: 7,
      headSha: "head1",
      baseSha: "base1",
      baseRef: "main",
      headRef: "feature",
      author: { kind: "human", login: "alice", id: 1 },
      labels: ["backend"],
      draft: true,
      ciStatus: "success",
      fromFork: false,
      url: "https://github.com/acme/widgets/pull/7",
      linkedTicket: { provider: "github-issue", id: "acme/widgets#9" },
      stats: { additions: 10, deletions: 2, files: 1 },
    });
    expect(change.files[0]).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      patch: expect.stringContaining("+b"),
    });
  });

  it("detects forks, including deleted forks", async () => {
    const fork = fakeOctokit({
      pr: basePr({ head: { sha: "h", ref: "f", repo: { full_name: "mallory/widgets" } } }),
    });
    expect((await githubSource({ octokit: fork.octokit }).getChange(ref)).fromFork).toBe(true);
    const gone = fakeOctokit({ pr: basePr({ head: { sha: "h", ref: "f", repo: null } }) });
    expect((await githubSource({ octokit: gone.octokit }).getChange(ref)).fromFork).toBe(true);
  });

  it("excludes its own checks and statuses from ciStatus", async () => {
    const { octokit } = fakeOctokit({
      checkRuns: [run("merge-safely/verdict", "completed", "failure"), run("tests", "completed", "success")],
      statuses: [{ context: "merge-safely/legacy", state: "pending" }],
    });
    expect((await githubSource({ octokit }).getChange(ref)).ciStatus).toBe("success");
  });

  it("reports unknown when only its own check exists, pending and failure otherwise", async () => {
    const own = fakeOctokit({ checkRuns: [run("merge-safely/verdict", "in_progress", null)] });
    expect((await githubSource({ octokit: own.octokit }).getChange(ref)).ciStatus).toBe("unknown");
    const pending = fakeOctokit({ checkRuns: [run("lint", "queued", null), run("tests", "completed", "success")] });
    expect((await githubSource({ octokit: pending.octokit }).getChange(ref)).ciStatus).toBe("pending");
    const failed = fakeOctokit({
      checkRuns: [run("tests", "completed", "timed_out")],
      statuses: [{ context: "ci", state: "pending" }],
    });
    expect((await githubSource({ octokit: failed.octokit }).getChange(ref)).ciStatus).toBe("failure");
  });

  it("paginates listFiles", async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
    }));
    const { octokit, calls } = fakeOctokit({ files });
    const change = await githubSource({ octokit }).getChange(ref);
    expect(change.files).toHaveLength(250);
    expect(change.files[0]?.status).toBe("added");
    expect(callsTo(calls, "pulls.listFiles")).toHaveLength(3);
  });
});

describe("githubSource.getDiff", () => {
  it("fetches base...head with the diff media type", async () => {
    const { octokit, calls } = fakeOctokit({ diffs: { "base1...head1": "diff --git a/x b/x\n" } });
    expect(await githubSource({ octokit }).getDiff(ref)).toBe("diff --git a/x b/x\n");
    expect(callsTo(calls, "repos.compareCommitsWithBasehead")[0]?.params).toMatchObject({
      basehead: "base1...head1",
      mediaType: { format: "diff" },
    });
  });

  it("fetches a delta since a sha", async () => {
    const { octokit } = fakeOctokit({ diffs: { "old9...head1": "delta" } });
    expect(await githubSource({ octokit }).getDiff(ref, { sinceSha: "old9" })).toBe("delta");
  });

  it("falls back to per-file patches when the PR exceeds 300 files, noting truncation", async () => {
    const files = [
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" },
      { filename: "bin.png", status: "added", additions: 0, deletions: 0 },
    ];
    const { octokit, calls } = fakeOctokit({ files, pr: basePr({ changed_files: 400 }) });
    const diff = await githubSource({ octokit }).getDiff(ref);
    expect(callsTo(calls, "repos.compareCommitsWithBasehead")).toHaveLength(0);
    expect(diff).toContain("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@");
    // 398 files beyond what listFiles returned + 1 without a patch.
    expect(diff.trimEnd().split("\n").pop()).toBe("# merge-safely: diff truncated (399 files omitted)");
  });

  it("falls back when the API rejects the diff as too large", async () => {
    const { octokit } = fakeOctokit({ diffs: { "base1...head1": httpError(406, "diff too large") } });
    const diff = await githubSource({ octokit }).getDiff(ref);
    expect(diff).toContain("+++ b/src/a.ts");
    expect(diff).not.toContain("truncated");
  });

  it("falls back to compare JSON patches for a too-large delta", async () => {
    const { octokit } = fakeOctokit({
      diffs: { "old9...head1": httpError(422, "too large") },
      compareFiles: {
        "old9...head1": [{ filename: "n.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" }],
      },
    });
    const diff = await githubSource({ octokit }).getDiff(ref, { sinceSha: "old9" });
    expect(diff).toContain("--- /dev/null\n+++ b/n.ts");
  });

  it("rethrows unrelated errors", async () => {
    const { octokit } = fakeOctokit({ diffs: { "base1...head1": httpError(500, "boom") } });
    await expect(githubSource({ octokit }).getDiff(ref)).rejects.toThrow("boom");
  });

  it("diffFromFiles handles renames and removals", () => {
    const out = diffFromFiles([
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0, patch: "@@ x" },
      { filename: "gone.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-x\n" },
    ]);
    expect(out).toContain("diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts");
    expect(out).toContain("--- a/gone.ts\n+++ /dev/null");
  });
});

describe("githubSource.getUntrustedContext", () => {
  it("caps items at 50 and 4k chars, keeps the latest, skips our own digests", async () => {
    const { octokit } = fakeOctokit({
      commits: Array.from({ length: 60 }, (_, i) => ({ sha: `s${i}`, commit: { message: `commit ${i}` } })),
      issueComments: [
        { id: 1, body: "x".repeat(5000), user: { login: "bob" } },
        { id: 2, body: "<!-- merge-safely round=1 sha=a -->\ndigest", user: { login: "merge-safely[bot]" } },
      ],
      reviewComments: [{ id: 3, body: "nit", path: "a.ts", user: { login: "carol" } }],
    });
    const ctx = await githubSource({ octokit }).getUntrustedContext?.(ref);
    expect(ctx?.commitMessages).toHaveLength(50);
    expect(ctx?.commitMessages[0]).toBe("commit 10");
    expect(ctx?.comments).toHaveLength(2);
    expect(ctx?.comments[0]?.length).toBeLessThanOrEqual(4000);
    expect(ctx?.comments[0]).toMatch(/^@bob: x/);
    expect(ctx?.comments[1]).toBe("@carol on a.ts: nit");
  });
});
