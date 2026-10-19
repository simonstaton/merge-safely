import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitFor } from "../src/commands/review.js";
import type { Exec } from "../src/exec.js";
import { harness, result, verdict } from "./helpers.js";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

async function connected(env: NodeJS.ProcessEnv = {}) {
  const h = harness({ env: { GITHUB_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-test-key-123456789", ...env } });
  const r = await h.run("connect", "anthropic", "--api-key-env", "ANTHROPIC_API_KEY");
  expect(r.code).toBe(0);
  return h;
}

describe("exit codes", () => {
  it("maps outcomes", () => {
    expect(exitFor("pass")).toBe(0);
    expect(exitFor("block")).toBe(1);
    expect(exitFor("pending")).toBe(2);
    expect(exitFor("contested")).toBe(2);
    expect(exitFor("error")).toBe(2);
    expect(exitFor("budget-blocked")).toBe(3);
  });

  it.each([
    ["pass", 0],
    ["block", 1],
    ["pending", 2],
    ["contested", 2],
    ["error", 2],
    ["budget-blocked", 3],
  ] as const)("run --repo --pr exits %s -> %i and prints the digest", async (outcome, code) => {
    const h = await connected();
    h.gate.reviewResult = result(outcome);
    const r = await h.run("run", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(code);
    expect(r.stdout).toContain(`Verdict: ${outcome.toUpperCase()}`);
  });
});

describe("run --repo --pr", () => {
  it("reads policy from the PR base branch, pins the head and defaults to status reporting for a PAT", async () => {
    const h = await connected();
    h.github.pull = { headSha: "1".repeat(40), baseRef: "release", baseSha: "2".repeat(40) };
    h.github.files["release:.merge-safely.yml"] = "budget: { perChangeUsd: 9 }\n";
    const r = await h.run("run", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(0);
    expect(h.github.fileRefs).toEqual(["release"]);
    const setup = h.gate.setups[0];
    expect(setup?.policy.policy.budget.perChangeUsd).toBe(9);
    expect(setup?.policy.source).toBe("acme/app@release:.merge-safely.yml");
    expect(setup?.target).toMatchObject({ mode: "pr", report: "status", store: "fs", tokenIdentity: "user" });
    expect(h.gate.calls[0]).toMatchObject({
      method: "review",
      arg: { ref: { repo: { owner: "acme", name: "app" }, number: 7 }, opts: { headSha: "1".repeat(40) } },
    });
  });

  it("uses github reporting for an Actions/App token and honours --head, --store and --policy", async () => {
    const h = await connected({ GITHUB_TOKEN: "ghs_installationtoken1234567890" });
    const policyPath = join(h.home, "p.yml");
    writeFileSync(policyPath, "rounds: { max: 2 }\n");
    const r = await h.run(
      "run",
      "--repo",
      "acme/app",
      "--pr",
      "7",
      "--head",
      "f".repeat(40),
      "--store",
      "sqlite",
      "--policy",
      policyPath,
    );
    expect(r.code).toBe(0);
    expect(h.github.fileRefs).toEqual([]);
    expect(h.gate.setups[0]?.target).toMatchObject({ report: "github", store: "sqlite", tokenIdentity: "app" });
    expect(h.gate.setups[0]?.policy.policy.rounds.max).toBe(2);
    expect(h.gate.calls[0]?.arg).toMatchObject({ opts: { headSha: "f".repeat(40) } });
  });

  it("--report json prints the verdict as JSON", async () => {
    const h = await connected();
    h.gate.reviewResult = result("block");
    const r = await h.run("run", "--repo", "acme/app", "--pr", "7", "--report", "json");
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { outcome: string; exitCode: number; verdict: { decision: string } };
    expect(parsed).toMatchObject({ outcome: "block", exitCode: 1, verdict: { decision: "block" } });
  });

  it("passes the Slack webhook from the environment", async () => {
    const h = await connected({ MERGE_SAFELY_SLACK_WEBHOOK: "https://hooks.slack.com/services/T/B/secretsecret" });
    await h.run("run", "--repo", "acme/app", "--pr", "7");
    expect(h.gate.setups[0]?.slackWebhook).toBe("https://hooks.slack.com/services/T/B/secretsecret");
  });

  it("rejects bad flags with a one-line usage error", async () => {
    const h = await connected();
    for (const args of [
      ["run", "--repo", "acme/app", "--pr", "abc"],
      ["run", "--repo", "nope", "--pr", "1"],
      ["run", "--repo", "acme/app", "--pr", "1", "--report", "fax"],
      ["frobnicate"],
    ]) {
      const r = await h.run(...args);
      expect(r.code).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).toMatch(/^error \[USAGE\]: /);
    }
  });

  it("fails clearly with no token, and with no connections", async () => {
    const h = harness();
    let r = await h.run("run", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [GITHUB_TOKEN_MISSING]");
    const h2 = harness({ env: { GITHUB_TOKEN: TOKEN } });
    r = await h2.run("run", "--repo", "acme/app", "--pr", "7");
    expect(r.stderr).toContain("error [NO_CONNECTIONS]");
  });

  it("prints gate errors as one line with the code and masks secrets", async () => {
    const h = await connected();
    const err = Object.assign(new Error(`provider said no to key sk-ant-test-key-123456789\nand token ${TOKEN}`), {
      code: "SEATING_FAILED",
    });
    h.gate.error = err;
    const r = await h.run("run", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("error [SEATING_FAILED]");
    expect(r.stderr).not.toContain("sk-ant-test-key-123456789");
    expect(r.stderr).not.toContain(TOKEN);
  });
});

describe("estimate", () => {
  it("prints tier, seats with models and connections, cost and ceilings without running", async () => {
    const h = await connected();
    const r = await h.run("estimate", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Tier 2");
    expect(r.stdout).toContain("hunter:correctness:1");
    expect(r.stdout).toContain("anthropic-main");
    expect(r.stdout).toContain("claude-opus-5-5");
    expect(r.stdout).toContain("Estimated cost: $1.06");
    expect(r.stdout).toContain("per-change");
    expect(r.stdout).toContain("Admission: would run");
    expect(h.gate.calls.map((c) => c.method)).toEqual(["estimate"]);
    expect(h.gate.setups[0]?.target).toMatchObject({ dryRun: true });
  });

  it("exits 3 when admission would refuse, and supports --json", async () => {
    const h = await connected();
    h.gate.estimateResult = { ...h.gate.estimateResult, admitted: false, blockedReason: "per-change over" };
    const r = await h.run("--json", "estimate", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ admitted: false, policy: { source: "defaults" } });
  });
});

describe("explain", () => {
  it("prints the latest digest, or says there is none", async () => {
    const h = await connected();
    let r = await h.run("explain", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("No verdict recorded");
    h.gate.explainResult = {
      verdict: verdict({ decision: "block" }),
      digest: { headline: "Verdict: BLOCK", markdown: "", text: "Verdict: BLOCK (tier 1)" },
    };
    r = await h.run("explain", "--repo", "acme/app", "--pr", "7");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Verdict: BLOCK (tier 1)");
  });
});

describe("verdict", () => {
  const ghUser: Exec = async (cmd, args) =>
    cmd === "gh" && args[0] === "api"
      ? { code: 0, stdout: "octocat\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "" };

  it("records a human verdict signed by the gh user", async () => {
    const h = harness({ env: { GITHUB_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-test-key-123456789" }, exec: ghUser });
    await h.run("connect", "anthropic", "--api-key-env", "ANTHROPIC_API_KEY");
    const sha = "d".repeat(40);
    const r = await h.run(
      "verdict",
      "--repo",
      "acme/app",
      "--pr",
      "7",
      "--sha",
      sha,
      "--decision",
      "pass",
      "--reason",
      "checked the backfill by hand",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Recorded human PASS");
    expect(h.gate.calls[0]).toMatchObject({
      method: "recordHumanVerdict",
      arg: { headSha: sha, decision: "pass", signedBy: { login: "octocat" }, reason: "checked the backfill by hand" },
    });
  });

  it("prefers --as, falls back to GITHUB_ACTOR, and validates its flags", async () => {
    const h = await connected({ GITHUB_ACTOR: "ci-bot" });
    const base = ["verdict", "--repo", "acme/app", "--pr", "7", "--sha", "abcdef1", "--reason", "ok"];
    let r = await h.run(...base, "--decision", "block");
    expect(r.code).toBe(0);
    expect(h.gate.calls.at(-1)?.arg).toMatchObject({ signedBy: { login: "ci-bot" }, decision: "block" });
    r = await h.run(...base, "--decision", "block", "--as", "alice");
    expect(h.gate.calls.at(-1)?.arg).toMatchObject({ signedBy: { login: "alice" } });
    r = await h.run(...base, "--decision", "maybe");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [USAGE]");
    r = await h.run("verdict", "--repo", "acme/app", "--pr", "7", "--sha", "abcdef1", "--decision", "pass");
    expect(r.stderr).toContain("--reason");
  });
});

describe("version and help", () => {
  it("prints the version", async () => {
    const h = harness();
    const r = await h.run("version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await h.run("--version")).code).toBe(0);
    expect((await h.run("--help")).stdout).toContain("connect");
  });
});
