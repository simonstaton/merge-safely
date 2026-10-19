import { DEFAULT_POLICY } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { anyOfStores, evaluateMergeGroup, type MergeGroupPr, runMergeGroup } from "../src/merge-group.js";
import { run } from "../src/run.js";
import { fakeGithub, HEAD, harness, memoryStore, QUEUE, verdict } from "./helpers.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const OLD = "4".repeat(40);
const pr = (over: Partial<MergeGroupPr> = {}): MergeGroupPr => ({
  number: 7,
  headSha: HEAD,
  atHead: verdict(),
  latest: null,
  ...over,
});

describe("evaluateMergeGroup", () => {
  it("all PRs have a pass on their current head -> ok", () => {
    const r = evaluateMergeGroup(
      [
        pr(),
        pr({ number: 8, atHead: verdict({ number: 8, kind: "human", signedBy: { kind: "human", login: "lead" } }) }),
      ],
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Merge queue: 2 PRs passed review");
    expect(r.summary).toContain(`#7: machine pass on ${HEAD.slice(0, 7)}, round 1`);
    expect(r.summary).toContain("#8: human (lead) pass");
  });

  it("one PR without a verdict -> failure naming it", () => {
    const r = evaluateMergeGroup([pr(), pr({ number: 8, atHead: null })], NOW);
    expect(r.ok).toBe(false);
    expect(r.title).toBe("Merge queue: #8 lacks a pass");
    expect(r.entries[1]).toMatchObject({ ok: false, detail: `no verdict on the current head ${HEAD.slice(0, 7)}` });
  });

  it("head moved since the last verdict -> failure explaining it", () => {
    const r = evaluateMergeGroup([pr({ atHead: null, latest: verdict({ headSha: OLD }) })], NOW);
    expect(r.ok).toBe(false);
    expect(r.entries[0]?.detail).toMatch(/latest \(pass\) is on 4444444, an older commit/);
  });

  it.each([
    ["block", verdict({ decision: "block" }), /is block/],
    ["pending", verdict({ decision: "pending" }), /is pending/],
    ["contested", verdict({ contested: true }), /contested/],
    ["expired", verdict({ expiresAt: "2026-10-01T00:00:00.000Z" }), /expired/],
    ["for another SHA", verdict({ headSha: OLD }), /no verdict on the current head/],
  ])("a %s verdict is not a pass", (_n, v, re) => {
    const r = evaluateMergeGroup([pr({ atHead: v })], NOW);
    expect(r.ok).toBe(false);
    expect(r.entries[0]?.detail).toMatch(re);
  });

  it("an empty group is never ok", () => {
    expect(evaluateMergeGroup([], NOW).ok).toBe(false);
  });
});

describe("runMergeGroup", () => {
  it("writes the policy-named check on the queue commit", async () => {
    const gh = fakeGithub();
    const policy = { ...DEFAULT_POLICY, reporting: { ...DEFAULT_POLICY.reporting, checkName: "ms/gate" } };
    const r = await runMergeGroup({
      octokit: gh.octokit,
      store: memoryStore([verdict()]),
      policy,
      repo: { host: "github.com", owner: "acme", name: "app" },
      headSha: QUEUE,
      prNumbers: [7],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      detailsUrl: "https://github.com/acme/app/actions/runs/1",
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    expect(gh.created).toEqual([
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        name: "ms/gate",
        head_sha: QUEUE,
        status: "completed",
        conclusion: "success",
        details_url: "https://github.com/acme/app/actions/runs/1",
        output: expect.objectContaining({ title: "Merge queue: 1 PR passed review" }),
      }),
    ]);
  });
});

describe("run: merge_group", () => {
  it("passes without needing connections when the PR has a pass on its head", async () => {
    const h = harness(
      "merge_group",
      "merge_group.checks_requested",
      { connections: "" },
      { store: memoryStore([verdict()]) },
    );
    expect(await run(h.deps)).toBe(0);
    expect(h.gh.created[0]).toMatchObject({ name: "merge-safely/verdict", head_sha: QUEUE, conclusion: "success" });
    expect(h.gh.fileReads).toEqual(["main:.merge-safely.yml"]);
    expect(h.core.outputs).toMatchObject({ decision: "pass", "check-url": "https://github.com/acme/app/runs/4242" });
    expect(h.core.summaries[0]).toMatch(/^## Merge queue: 1 PR passed review/);
    expect(h.factory.setups).toHaveLength(0);
  });

  it("fails the check (and the job) when the PR's head moved past its verdict", async () => {
    const h = harness(
      "merge_group",
      "merge_group.checks_requested",
      {},
      { store: memoryStore([verdict({ headSha: OLD })]) },
    );
    expect(await run(h.deps)).toBe(1);
    expect(h.gh.created[0]).toMatchObject({ conclusion: "failure" });
    expect(h.core.failed[0]).toBe("Merge queue: #7 lacks a pass");
    expect(h.core.outputs.decision).toBe("block");
  });

  it("fail-on-block false leaves the job green but the check failing", async () => {
    const h = harness(
      "merge_group",
      "merge_group.checks_requested",
      { "fail-on-block": "false" },
      { store: memoryStore([]) },
    );
    expect(await run(h.deps)).toBe(0);
    expect(h.gh.created[0]).toMatchObject({ conclusion: "failure" });
  });
});

describe("anyOfStores", () => {
  it("returns the newest verdict any trusted app holds and merges history", async () => {
    const older = verdict({ createdAt: "2026-10-01T00:00:00.000Z", decision: "block" });
    const newer = verdict({ createdAt: "2026-10-02T00:00:00.000Z" });
    const s = anyOfStores([memoryStore([older]), memoryStore([newer])]);
    expect((await s.get({ repo: newer.repo, number: 7, headSha: HEAD }))?.verdict.decision).toBe("pass");
    expect(await s.listForChange(newer.repo, 7)).toHaveLength(2);
    await expect(s.put(newer, { version: null })).rejects.toThrow(/read-only/);
  });
});

describe("run: merge_group trust", () => {
  it("passes verdict-app-slugs plus the token's own app to the verdict lookup", async () => {
    const seen: string[][] = [];
    const h = harness("merge_group", "merge_group.checks_requested", { "verdict-app-slugs": "merge-safely" });
    h.deps.verdictStore = (_o, _p, _l, slugs) => {
      seen.push(slugs);
      return memoryStore([verdict()]);
    };
    expect(await run(h.deps)).toBe(0);
    expect(seen).toEqual([["merge-safely", "github-actions"]]);
  });

  it("a block on the PR head fails the queue check with the reason", async () => {
    const h = harness(
      "merge_group",
      "merge_group.checks_requested",
      {},
      { store: memoryStore([verdict({ decision: "block" })]) },
    );
    expect(await run(h.deps)).toBe(1);
    expect(h.gh.created[0]).toMatchObject({ conclusion: "failure" });
    expect(String(h.gh.created[0]?.output?.summary)).toMatch(/#7: machine verdict on 1111111 is block/);
  });
});
