import { describe, expect, it } from "vitest";
import { change, digest, verdict } from "../test/builders.js";
import { fakeOctokit } from "../test/fake-octokit.js";
import { commitStatusReporter } from "./commit-status.js";

describe("commitStatusReporter", () => {
  it("maps events to commit statuses on the head sha", async () => {
    const { octokit, state } = fakeOctokit();
    const r = commitStatusReporter({ octokit });
    await r.report({ type: "pending", change: change(), tier: verdict().tier, round: 1 });
    await r.report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pass" }),
      digest: digest({ headline: "PASS" }),
    });
    await r.report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest({ headline: "x".repeat(300) }),
    });
    await r.report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pass", contested: true }),
      digest: digest(),
    });
    await r.report({
      type: "escalated",
      change: change(),
      verdict: verdict(),
      digest: digest(),
      handle: { id: "E", url: "https://esc.test", createdAt: "" },
    });
    await r.report({ type: "error", change: change(), round: 1, error: "ghp_secretsecretsecretsecret00" });
    expect(state.commitStatuses.map((s) => s.state)).toEqual([
      "pending",
      "success",
      "failure",
      "pending",
      "pending",
      "failure",
    ]);
    expect(state.commitStatuses.every((s) => s.context === "merge-safely/verdict" && s.sha === "head1")).toBe(true);
    expect(state.commitStatuses[2]?.description?.length).toBeLessThanOrEqual(140);
    expect(state.commitStatuses[4]?.target_url).toBe("https://esc.test");
    expect(state.commitStatuses[5]?.description).not.toContain("ghp_");
  });

  it("accepts a custom context", async () => {
    const { octokit, state } = fakeOctokit();
    await commitStatusReporter({ octokit, context: "merge-safely/pat" }).report({
      type: "pending",
      change: change(),
      round: 1,
    });
    expect(state.commitStatuses[0]?.context).toBe("merge-safely/pat");
  });
});
