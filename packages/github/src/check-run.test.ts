import { DEFAULT_POLICY } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { change, digest, finding, verdict } from "../test/builders.js";
import { callsTo, fakeOctokit } from "../test/fake-octokit.js";
import { checkRunReporter, findingsToAnnotations } from "./check-run.js";
import { conclusionForVerdict } from "./check-run-shared.js";

describe("conclusionForVerdict", () => {
  it("maps decisions", () => {
    expect(conclusionForVerdict({ decision: "pass" })).toBe("success");
    expect(conclusionForVerdict({ decision: "block" })).toBe("failure");
    expect(conclusionForVerdict({ decision: "pending" })).toBe("action_required");
    expect(conclusionForVerdict({ decision: "pass", contested: true })).toBe("action_required");
    expect(conclusionForVerdict({ decision: "block", contested: true })).toBe("failure");
  });
});

describe("findingsToAnnotations", () => {
  it("only annotates findings with file and line, mapping severity to level", () => {
    const out = findingsToAnnotations([
      finding({ severity: "blocker", endLine: 5 }),
      finding({ id: "f2", severity: "important", line: 9, endLine: 3 }),
      finding({ id: "f3", severity: "nit", file: undefined }),
      finding({ id: "f4", severity: "pre-existing", line: undefined }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "src/a.ts", start_line: 2, end_line: 5, annotation_level: "failure" });
    expect(out[1]).toMatchObject({ start_line: 9, end_line: 9, annotation_level: "warning" });
  });
});

describe("checkRunReporter", () => {
  it("creates an in-progress run on pending, then updates the same run on verdict", async () => {
    const { octokit, state, calls } = fakeOctokit();
    const reporter = checkRunReporter({ octokit });
    const tier = verdict().tier;
    await reporter.report({ type: "pending", change: change(), tier, round: 1 });
    expect(state.checkRuns).toHaveLength(1);
    expect(state.checkRuns[0]).toMatchObject({
      name: "merge-safely/verdict",
      head_sha: "head1",
      status: "in_progress",
      output: { title: "Review in progress (tier 2)" },
    });

    await reporter.report({ type: "verdict", change: change(), verdict: verdict(), digest: digest() });
    expect(state.checkRuns).toHaveLength(1);
    expect(callsTo(calls, "checks.create")).toHaveLength(1);
    const run = state.checkRuns[0];
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(run?.output.title).toBe("Verdict: BLOCK (tier 2, round 1)");
    expect(run?.output.summary).toBe("## Blockers\n- thing");
    expect(run?.annotations).toHaveLength(1);
    expect(callsTo(calls, "checks.listForRef")[0]?.params).toMatchObject({
      check_name: "merge-safely/verdict",
      ref: "head1",
    });
  });

  it("creates a completed run when no pending run exists, with pass -> success", async () => {
    const { octokit, state } = fakeOctokit();
    await checkRunReporter({ octokit, checkName: "merge-safely/custom", detailsUrl: "https://x.test/d" }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pass", findings: [] }),
      digest: digest({ headline: "PASS" }),
    });
    expect(state.checkRuns[0]).toMatchObject({
      name: "merge-safely/custom",
      conclusion: "success",
      details_url: "https://x.test/d",
    });
  });

  it("maps pending verdicts to action_required", async () => {
    const { octokit, state } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pending" }),
      digest: digest(),
    });
    expect(state.checkRuns[0]?.conclusion).toBe("action_required");
  });

  it("batches annotations 50 per request", async () => {
    const { octokit, state, calls } = fakeOctokit();
    const findings = Array.from({ length: 120 }, (_, i) => finding({ id: `f${i}`, line: i + 1 }));
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ findings }),
      digest: digest(),
    });
    const create = callsTo(calls, "checks.create");
    const updates = callsTo(calls, "checks.update");
    expect(create).toHaveLength(1);
    expect(updates).toHaveLength(2);
    const sizes = [...create, ...updates].map(
      (c) => ((c.params.output as { annotations?: unknown[] }).annotations ?? []).length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(state.checkRuns[0]?.annotations).toHaveLength(120);
  });

  it("truncates an oversized summary to 65,535 chars", async () => {
    const { octokit, state } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest({ markdown: "y".repeat(100_000) }),
    });
    expect(state.checkRuns[0]?.output.summary?.length).toBeLessThanOrEqual(65_535);
  });

  it("escalated -> action_required with the escalation link", async () => {
    const { octokit, state } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "escalated",
      change: change(),
      verdict: verdict(),
      digest: digest(),
      handle: { id: "ESC-1", url: "https://slack.test/esc/1", createdAt: "2026-01-01T00:00:00Z" },
    });
    expect(state.checkRuns[0]).toMatchObject({
      conclusion: "action_required",
      details_url: "https://slack.test/esc/1",
    });
    expect(state.checkRuns[0]?.output.summary).toContain("https://slack.test/esc/1");
  });

  it("budget-blocked and error -> failure, keeping any stored verdict text and redacting secrets", async () => {
    const { octokit, state } = fakeOctokit();
    const reporter = checkRunReporter({ octokit });
    await reporter.report({ type: "verdict", change: change(), verdict: verdict(), digest: digest() });
    const stored = "STORED";
    if (state.checkRuns[0]) state.checkRuns[0].output.text = stored;
    await reporter.report({
      type: "budget-blocked",
      change: change(),
      tier: verdict().tier,
      reason: "over",
      ceiling: "perChangeUsd",
      digest: digest({ headline: "Budget exceeded", markdown: "over budget" }),
    });
    expect(state.checkRuns[0]).toMatchObject({
      conclusion: "failure",
      output: { title: "Budget exceeded", text: stored },
    });
    await reporter.report({
      type: "error",
      change: change(),
      round: 2,
      error: "request failed: Authorization: token ghs_abcdefghijklmnopqrstuvwxyz123",
    });
    expect(state.checkRuns).toHaveLength(1);
    expect(state.checkRuns[0]).toMatchObject({ conclusion: "failure", output: { title: "Review failed" } });
    expect(state.checkRuns[0]?.output.summary).not.toContain("ghs_abc");
  });

  it("never writes verdict text itself and re-sends the stored text unchanged", async () => {
    const { octokit, state, calls } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(state.checkRuns[0]?.output.text).toBeNull();
    expect(callsTo(calls, "checks.create")[0]?.params.output).not.toHaveProperty("text");
    if (state.checkRuns[0]) state.checkRuns[0].output.text = "STORED";
    await checkRunReporter({ octokit }).report({ type: "pending", change: change(), round: 2 });
    const lastOutput = callsTo(calls, "checks.update").pop()?.params.output as { text?: string } | undefined;
    expect(lastOutput?.text).toBe("STORED");
  });

  it("does not re-post annotations on a same-SHA re-run of an annotated run", async () => {
    const { octokit, state, calls } = fakeOctokit();
    const reporter = checkRunReporter({ octokit });
    const ev = { type: "verdict" as const, change: change(), verdict: verdict(), digest: digest() };
    await reporter.report(ev);
    expect(state.checkRuns[0]?.annotations).toHaveLength(1);
    await reporter.report({ ...ev, verdict: verdict({ round: 2 }), digest: digest({ headline: "round 2" }) });
    expect(state.checkRuns[0]?.annotations).toHaveLength(1);
    expect(state.checkRuns[0]?.output.title).toBe("round 2");
    expect(callsTo(calls, "checks.update").pop()?.params.output).not.toHaveProperty("annotations");
  });

  it("ignores same-named check runs from other apps", async () => {
    const { octokit, state } = fakeOctokit();
    state.writerApp = { id: 666, slug: "evil-app" };
    await octokit.checks.create({ owner: "acme", repo: "widgets", name: "merge-safely/verdict", head_sha: "head1" });
    state.writerApp = undefined;
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(state.checkRuns).toHaveLength(2);
    expect(state.checkRuns[0]?.conclusion).toBeNull();
    expect(state.checkRuns[1]).toMatchObject({ conclusion: "failure", app: { slug: "merge-safely" } });
  });

  it("takes the check name from policy", async () => {
    const { octokit, state } = fakeOctokit();
    const policy = { reporting: { ...DEFAULT_POLICY.reporting, checkName: "merge-safely/gate" } };
    await checkRunReporter({ octokit, policy }).report({ type: "pending", change: change(), round: 1 });
    expect(state.checkRuns[0]?.name).toBe("merge-safely/gate");
  });

  it("updates the newest run when duplicates exist for the SHA", async () => {
    const { octokit, state, calls } = fakeOctokit();
    const reporter = checkRunReporter({ octokit });
    await octokit.checks.create({ owner: "acme", repo: "widgets", name: "merge-safely/verdict", head_sha: "head1" });
    await octokit.checks.create({ owner: "acme", repo: "widgets", name: "merge-safely/verdict", head_sha: "head1" });
    await reporter.report({ type: "verdict", change: change(), verdict: verdict(), digest: digest() });
    const newest = Math.max(...state.checkRuns.map((r) => r.id));
    expect(callsTo(calls, "checks.update")[0]?.params.check_run_id).toBe(newest);
  });
});
