import type { CheckRunData } from "@merge-safely/github";
import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";
import { digest, fixture, HEAD, harness, pullData, result, verdict } from "./helpers.js";

const KEY = "sk-ant-api03-supersecretvalue1234";

function ownCheckRun(id: number, headSha = HEAD): CheckRunData {
  return {
    id,
    name: "merge-safely/verdict",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    started_at: null,
    completed_at: null,
    output: { title: null, summary: null, text: null },
    app: { id: 15368, slug: "github-actions" },
  };
}

describe("run: pull_request review", () => {
  it("builds the gate setup the design asks for and reviews the event head", async () => {
    const h = harness("pull_request", "pull_request.synchronize", { concurrency: "3" });
    h.gh.files["main:.merge-safely.yml"] = "budget: { perChangeUsd: 9 }\n";
    const code = await run(h.deps);
    expect(code).toBe(0);
    expect(h.core.failed).toEqual([]);
    const setup = h.factory.setups[0];
    expect(setup?.target).toEqual({
      mode: "pr",
      repo: { host: "github.com", owner: "acme", name: "app" },
      token: "ghs_workflowtoken000000000000",
      tokenIdentity: "app",
      report: "github",
      store: "checkrun",
      dryRun: false,
    });
    expect(setup?.policy.policy.budget.perChangeUsd).toBe(9);
    expect(setup?.policy.source).toBe("acme/app@main:.merge-safely.yml");
    expect(setup?.connections.map((c) => c.id)).toEqual(["anthropic-main"]);
    expect(setup?.concurrency).toBe(3);
    expect(setup?.validateConnections).toBe(true);
    expect(setup?.paths.home).toBe("/runner/tmp/merge-safely");
    expect(h.factory.gate.calls).toEqual([
      {
        ref: { repo: { host: "github.com", owner: "acme", name: "app" }, number: 7 },
        opts: { headSha: HEAD, trigger: "action:pull_request" },
      },
    ]);
    expect(h.gh.fileReads).toEqual(["main:.merge-safely.yml"]);
  });

  it("masks the token and every connection secret", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    await run(h.deps);
    expect(h.core.secrets).toEqual(expect.arrayContaining(["ghs_workflowtoken000000000000", KEY]));
    expect(h.core.all()).not.toContain(KEY);
  });

  it("sets every output and writes the digest plus the cost line to the job summary", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    h.gh.checkRuns.push(ownCheckRun(555));
    h.factory.gate.reviewResult = result("pass", {
      digest: digest("PASS (tier 2, round 1)", "## PASS (tier 2, round 1)\n\nNo blocking findings."),
      verdict: verdict({
        round: 2,
        cost: {
          usd: 0.4321,
          tokens: { in: 1200, out: 300 },
          bySeat: { h1: { connectionId: "anthropic-main", model: "m" } },
        },
      }),
    });
    await run(h.deps);
    expect(h.core.outputs).toMatchObject({
      decision: "pass",
      tier: "2",
      round: "2",
      "cost-usd": "0.432100",
      "check-url": "https://github.com/acme/app/runs/555",
    });
    const vj = JSON.parse(h.core.outputs["verdict-json"] ?? "{}") as Record<string, unknown>;
    expect(vj).toMatchObject({ decision: "pass", headSha: HEAD, round: 2, tier: 2, costUsd: 0.4321 });
    expect(h.core.outputs["verdict-json"]).not.toContain("\n");
    const summary = h.core.summaries.join("");
    expect(summary).toContain("No blocking findings.");
    expect(summary).toMatch(/\*\*Cost:\*\* \$0\.4321 · 1,200 tokens in \/ 300 out · 0 seats · anthropic-main: 1/);
    expect(summary).toContain("[Verdict check run](https://github.com/acme/app/runs/555)");
  });

  it("does not repeat a cost line the digest already has", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    h.factory.gate.reviewResult = result("pass", { digest: digest("PASS", "## PASS\n\n**Cost:** $0.01") });
    await run(h.deps);
    expect(h.core.summaries.join("").match(/\*\*Cost:\*\*/g)).toHaveLength(1);
  });

  it.each([
    ["pass", "true", 0, null],
    ["block", "true", 1, /blocked this change/],
    ["block", "false", 0, null],
    ["pending", "true", 2, /pending/],
    ["pending", "false", 2, /pending/],
    ["contested", "true", 2, /contested/],
    ["error", "false", 2, /could not complete the review: provider down/],
    ["budget-blocked", "false", 3, /budget ceiling: perChangeUsd \$25 reached.*Raise the ceiling/],
  ] as const)("outcome %s with fail-on-block=%s -> exit %i", async (outcome, failOnBlock, code, failure) => {
    const h = harness("pull_request", "pull_request.synchronize", { "fail-on-block": failOnBlock });
    h.factory.gate.reviewResult = result(outcome, {
      ...(outcome === "error" ? { reason: "provider down" } : {}),
      ...(outcome === "budget-blocked" ? { reason: "perChangeUsd $25 reached" } : {}),
    });
    expect(await run(h.deps)).toBe(code);
    expect(h.core.outputs.decision).toBe(outcome);
    if (failure) expect(h.core.failed.join("\n")).toMatch(failure);
    else expect(h.core.failed).toEqual([]);
    if (outcome === "block" && failOnBlock === "false") {
      expect(h.core.logs.some((l) => l.level === "warning" && /fail-on-block is false/.test(l.msg))).toBe(true);
    }
  });

  it("skips drafts with a notice and reviews nothing", async () => {
    const h = harness("pull_request", "pull_request.opened.draft");
    expect(await run(h.deps)).toBe(0);
    expect(h.factory.setups).toHaveLength(0);
    expect(h.core.outputs.decision).toBe("skipped");
    expect(h.core.logs.find((l) => l.level === "notice")?.msg).toMatch(/draft/);
  });

  it("invalid policy on the base branch fails with the schema errors", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    h.gh.files["main:.merge-safely.yml"] = "quorum: { t9: 1 }\n";
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/^error \[POLICY_INVALID\]: acme\/app@main:.merge-safely.yml is invalid/);
    expect(h.factory.setups).toHaveLength(0);
  });

  it("bad connections fail with the fix and without the secret", async () => {
    const h = harness("pull_request", "pull_request.synchronize", {
      connections: `anthropic-main: { provider: anthropic, apiKey: "${KEY}", colour: blue }`,
    });
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/^error \[CONNECTIONS_INVALID\]: connections input is invalid/);
    expect(h.core.all()).not.toContain(KEY);
  });

  it("missing connections input fails before anything else", async () => {
    const h = harness("pull_request", "pull_request.synchronize", { connections: "" });
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/^error \[INPUT\]: connections input is required/);
  });

  it("gate failures surface as one clean error", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    h.deps.gateFactory = async () => {
      throw new Error(`createGate missing; key ${KEY}`);
    };
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/^error \[ERROR\]: createGate missing/);
    expect(h.core.all()).not.toContain(KEY);
  });

  it("GitHub 403 explains the permissions block", async () => {
    const h = harness("pull_request", "pull_request.synchronize");
    h.gh.octokit.pulls.get = async () => {
      throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    };
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/permissions: \{ checks: write, pull-requests: write, contents: read \}/);
  });

  it("warns when github-token is a personal token", async () => {
    const h = harness("pull_request", "pull_request.synchronize", {
      "github-token": "ghp_personal0000000000000000000000000000",
    });
    await run(h.deps);
    expect(h.factory.setups[0]?.target).toMatchObject({ tokenIdentity: "user" });
    expect(h.core.logs.some((l) => l.level === "warning" && /personal token/.test(l.msg))).toBe(true);
  });
});

describe("run: forks", () => {
  it("pull_request from a fork fails early with the pull_request_target guidance", async () => {
    const h = harness("pull_request", "pull_request.opened.fork", {
      connections: 'a: { provider: anthropic, apiKey: "" }',
    });
    expect(await run(h.deps)).toBe(2);
    expect(h.core.failed[0]).toMatch(/^error \[FORK_PULL_REQUEST\]: This pull request comes from a fork/);
    expect(h.core.failed[0]).toMatch(/pull_request_target/);
    expect(h.factory.setups).toHaveLength(0);
  });

  it("pull_request_target from a fork proceeds with base policy and allowedCommands overridden to []", async () => {
    const h = harness(
      "pull_request_target",
      "pull_request_target.opened.fork",
      { policy: "ms.yml" },
      { pull: pullData({ headRepo: "mallory/app" }) },
    );
    h.files["/work/app/ms.yml"] = "quorum: { t1: 1 }\n"; // the fork's checkout must be ignored
    h.gh.files["main:ms.yml"] = "runner: { allowedCommands: ['npm test'] }\n";
    expect(await run(h.deps)).toBe(0);
    const setup = h.factory.setups[0];
    expect(setup?.policy.policy.runner.allowedCommands).toEqual([]);
    expect(setup?.policy.source).toMatch(/^acme\/app@main:ms.yml \(allowedCommands disabled: fork PR\)/);
    const warnings = h.core.logs.filter((l) => l.level === "warning").map((l) => l.msg);
    expect(warnings.some((w) => w.startsWith("SECURITY: runner.allowedCommands is set"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("ignoring ms.yml in the runner checkout"))).toBe(true);
  });

  it("workflow_dispatch on a fork PR (seen via the API) also disables commands", async () => {
    const h = harness(
      "workflow_dispatch",
      "workflow_dispatch",
      { "pr-number": "7" },
      { pull: pullData({ headRepo: null }) },
    );
    h.gh.files["main:.merge-safely.yml"] = "runner: { allowedCommands: ['make test'] }\n";
    expect(await run(h.deps)).toBe(0);
    expect(h.factory.setups[0]?.policy.policy.runner.allowedCommands).toEqual([]);
  });
});

describe("run: other review events", () => {
  it("workflow_dispatch reviews the PR's current head (or head-sha)", async () => {
    const h = harness(
      "workflow_dispatch",
      "workflow_dispatch",
      { "pr-number": "7" },
      { pull: pullData({ headSha: "9".repeat(40), baseRef: "release" }) },
    );
    h.gh.files["release:.merge-safely.yml"] = "budget: { perChangeUsd: 7 }\n";
    expect(await run(h.deps)).toBe(0);
    expect(h.factory.gate.calls[0]?.opts).toMatchObject({ headSha: "9".repeat(40) });
    expect(h.factory.setups[0]?.policy.policy.budget.perChangeUsd).toBe(7);

    const h2 = harness("workflow_dispatch", "workflow_dispatch", { "pr-number": "7", "head-sha": "8".repeat(40) });
    await run(h2.deps);
    expect(h2.factory.gate.calls[0]?.opts).toMatchObject({ headSha: "8".repeat(40) });
  });

  it("check_run rerequested re-reviews that head", async () => {
    const h = harness("check_run", fixture("check_run.rerequested"));
    expect(await run(h.deps)).toBe(0);
    expect(h.factory.gate.calls[0]?.opts).toEqual({ headSha: HEAD, trigger: "action:check_run" });
  });

  it("an explicit policy in the checkout is used for same-repo PRs", async () => {
    const h = harness("pull_request", "pull_request.synchronize", { policy: "config/ms.yml" });
    h.files["/work/app/config/ms.yml"] = "budget: { perChangeUsd: 2 }\n";
    await run(h.deps);
    expect(h.factory.setups[0]?.policy.source).toBe("checkout:config/ms.yml");
    expect(h.factory.setups[0]?.policy.policy.budget.perChangeUsd).toBe(2);
  });

  it("passes the Slack webhook through, masked", async () => {
    const url = "https://hooks.slack.com/services/T000/B000/abcdefghijkl";
    const h = harness("pull_request", "pull_request.synchronize", { "slack-webhook": url });
    await run(h.deps);
    expect(h.factory.setups[0]?.slackWebhook).toBe(url);
    expect(h.core.secrets).toContain(url);
  });
});
