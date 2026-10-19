import { DEFAULT_POLICY } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { change, digest, finding, verdict } from "../test/builders.js";
import { callsTo, fakeOctokit } from "../test/fake-octokit.js";
import { commentableLines, prReviewReporter, reviewMarker } from "./pr-review.js";

const reporting = (over: Partial<typeof DEFAULT_POLICY.reporting> = {}) => ({
  reporting: { ...DEFAULT_POLICY.reporting, ...over },
});

describe("commentableLines", () => {
  it("collects added and context lines on the right side", () => {
    const lines = commentableLines(
      "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n@@ -20,1 +21,1 @@\n-x\n+y\n\\ No newline at end of file",
    );
    expect([...lines].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 21]);
  });
});

describe("prReviewReporter", () => {
  it("requests changes on block with a hidden marker and inline comments on changed lines only", async () => {
    const { octokit, state } = fakeOctokit({
      files: [
        { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" },
      ],
    });
    const findings = [
      finding({ id: "in", line: 2 }),
      finding({ id: "outside-hunk", line: 40 }),
      finding({ id: "other-file", file: "src/not-in-pr.ts", line: 1 }),
      finding({ id: "no-loc", file: undefined, line: undefined }),
    ];
    await prReviewReporter({ octokit, policy: reporting() }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ findings }),
      digest: digest(),
    });
    expect(state.reviews).toHaveLength(1);
    const review = state.reviews[0];
    expect(review?.event).toBe("REQUEST_CHANGES");
    expect(review?.commit_id).toBe("head1");
    expect(review?.body.startsWith("<!-- merge-safely round=1 sha=head1 -->\n## Blockers")).toBe(true);
    expect(review?.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("Unbatched") },
    ]);
  });

  it("comments (never approves) on pass, and on block when requestChangesOnBlock is false", async () => {
    const pass = fakeOctokit();
    await prReviewReporter({ octokit: pass.octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pass", findings: [] }),
      digest: digest(),
    });
    expect(pass.state.reviews[0]?.event).toBe("COMMENT");

    const soft = fakeOctokit();
    await prReviewReporter({ octokit: soft.octokit, policy: reporting({ requestChangesOnBlock: false }) }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(soft.state.reviews[0]?.event).toBe("COMMENT");
  });

  it("is idempotent per sha and round", async () => {
    const { octokit, state } = fakeOctokit();
    const reporter = prReviewReporter({ octokit });
    const ev = { type: "verdict" as const, change: change(), verdict: verdict(), digest: digest() };
    await reporter.report(ev);
    await reporter.report(ev);
    expect(state.reviews).toHaveLength(1);
    await reporter.report({ ...ev, verdict: verdict({ round: 2 }) });
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews[1]?.body).toContain(reviewMarker("merge-safely", 2, "head1"));
  });

  it("ignores markers posted by humans", async () => {
    const { octokit, state } = fakeOctokit({
      reviews: [
        {
          id: 1,
          body: reviewMarker("merge-safely", 1, "head1"),
          commit_id: "head1",
          user: { login: "mallory", type: "User" },
        },
      ],
    });
    await prReviewReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(state.reviews).toHaveLength(2);
  });

  it("skips inline comments when disabled and does nothing when postPrReview is false or on pending", async () => {
    const { octokit, state, calls } = fakeOctokit();
    await prReviewReporter({ octokit, policy: reporting({ inlineComments: false }) }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(state.reviews[0]?.comments).toBeUndefined();
    expect(callsTo(calls, "pulls.listFiles")).toHaveLength(0);

    const off = fakeOctokit();
    const r = prReviewReporter({ octokit: off.octokit, policy: reporting({ postPrReview: false }) });
    await r.report({ type: "verdict", change: change(), verdict: verdict(), digest: digest() });
    await prReviewReporter({ octokit: off.octokit }).report({ type: "pending", change: change(), round: 1 });
    expect(off.calls).toHaveLength(0);
  });

  it("retries without inline comments when GitHub rejects a comment line", async () => {
    const { octokit, state } = fakeOctokit({ failReviewWithComments: true });
    await prReviewReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]?.comments).toBeUndefined();
  });

  it("posts idempotent marker comments on error and budget-blocked without leaking error text", async () => {
    const { octokit, state } = fakeOctokit();
    const reporter = prReviewReporter({ octokit, marker: "ms" });
    const err = { type: "error" as const, change: change(), round: 1, error: "internal: secret path /srv/x" };
    await reporter.report(err);
    await reporter.report(err);
    const budget = {
      type: "budget-blocked" as const,
      change: change(),
      tier: verdict().tier,
      reason: "over",
      ceiling: "perChangeUsd",
      digest: digest({ markdown: "Spent $25 of $25" }),
    };
    await reporter.report(budget);
    await reporter.report(budget);
    expect(state.issueComments).toHaveLength(2);
    expect(state.issueComments[0]?.body).toMatch(/^<!-- ms kind=error round=1 sha=head1 -->/);
    expect(state.issueComments[0]?.body).not.toContain("/srv/x");
    expect(state.issueComments[1]?.body).toMatch(/^<!-- ms kind=budget-blocked sha=head1 -->/);
    expect(state.issueComments[1]?.body).toContain("Spent $25 of $25");
  });

  it("posts escalations as a review with the link", async () => {
    const { octokit, state } = fakeOctokit();
    await prReviewReporter({ octokit }).report({
      type: "escalated",
      change: change(),
      verdict: verdict({ decision: "pending" }),
      digest: digest(),
      handle: { id: "ESC-1", url: "https://slack.test/e", createdAt: "2026-01-01T00:00:00Z" },
    });
    expect(state.reviews[0]?.event).toBe("COMMENT");
    expect(state.reviews[0]?.body).toContain("https://slack.test/e");
  });
});
