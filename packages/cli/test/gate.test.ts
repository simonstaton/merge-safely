import type * as core from "@merge-safely/core";
import { DEFAULT_POLICY, policyHash } from "@merge-safely/core";
import { createProviderRegistry } from "@merge-safely/providers";
import { makeChange } from "@merge-safely/testkit";
import { describe, expect, it } from "vitest";
import { autoModels, seatTokens, tierCosts } from "../src/cost.js";
import { buildGateDeps, lensPrompts, registryPricing, toCliEstimate, toCliResult } from "../src/gate.js";
import type { GateSetup } from "../src/gate-types.js";
import { homePaths } from "../src/home.js";
import { fakeProvider, model, tempDir, verdict } from "./helpers.js";

const policy = { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const conn: core.Connection = {
  id: "anthropic-main",
  provider: "anthropic",
  kind: "api-key",
  createdAt: "2026-10-19T00:00:00Z",
  secret: { kind: "api-key", apiKey: "sk-ant-xxxxxxxxxxxxxxxx" },
};

function setup(target: GateSetup["target"]): GateSetup {
  return { target, policy, connections: [conn], paths: homePaths(tempDir()), logger };
}

describe("gate wiring", () => {
  it("builds local deps: working tree workspace, memory store, ledger, memory reporter, installation 'local'", async () => {
    const { deps, reporters } = await buildGateDeps(
      setup({ mode: "local", root: "/tmp" }),
      createProviderRegistry([fakeProvider()]),
    );
    expect(deps.source).toBeUndefined();
    expect(deps.installationId).toBe("local");
    expect(reporters).toHaveLength(1);
    expect(deps.policyHash).toBe(policy.hash);
    expect(typeof (deps.prompts as { hunter: unknown }).hunter).toBe("function");
    const catalog = deps.catalog as (id: string) => core.ModelInfo[];
    expect(catalog("anthropic-main").map((m) => m.name)).toContain("claude-opus-5-5");
    expect(deps.advisoryCeilings).toEqual(["monthly"]);
  });

  it("builds PR deps per --report / --store and nothing for --dry-run", async () => {
    const reg = createProviderRegistry([fakeProvider()]);
    const repo = { host: "github.com", owner: "acme", name: "app" };
    const pr = (report: "github" | "status" | "stdout" | "json", dryRun = false) =>
      setup({ mode: "pr", repo, token: "ghs_x", tokenIdentity: "app", report, store: "fs", dryRun });
    expect((await buildGateDeps(pr("github"), reg)).reporters).toHaveLength(2);
    expect((await buildGateDeps(pr("status"), reg)).reporters).toHaveLength(2);
    expect((await buildGateDeps(pr("stdout"), reg)).reporters).toHaveLength(0);
    expect((await buildGateDeps(pr("github", true), reg)).reporters).toHaveLength(0);
    const { deps } = await buildGateDeps(pr("github"), reg);
    expect(deps.installationId).toBe("acme/app");
    expect(deps.source).toBeDefined();
  });

  it("registry pricing steps down within the connection's catalog", () => {
    const models = [model("claude-opus-5-5", "frontier"), model("claude-sonnet-5-5", "mid")];
    const p = registryPricing();
    const next = p.cheaper({ connectionId: "c", provider: "anthropic", name: "claude-opus-5-5" }, models);
    expect(next).toEqual({ connectionId: "c", provider: "anthropic", name: "claude-sonnet-5-5" });
    expect(p.cheaper({ connectionId: "c", provider: "anthropic", name: "unknown" }, models)).toBeUndefined();
    expect(p.price(model("x", "mid"), { in: 1_000_000, out: 0 }).usd).toBe(3);
  });

  it("builds lens prompts by lens id", () => {
    expect(typeof lensPrompts.hunter).toBe("function");
    expect(() => lensPrompts.hunter("no-such-lens", {} as never)).toThrow();
  });
});

const digest = { headline: "h", markdown: "m", text: "t" };

describe("result normalisation", () => {
  it("maps verdicts, contested, outages and budget refusals", () => {
    expect(toCliResult({ verdict: verdict(), digest, events: [] })).toMatchObject({ outcome: "pass", digest });
    expect(toCliResult({ verdict: verdict(), digest, events: [], contested: true }).outcome).toBe("contested");
    expect(toCliResult({ verdict: verdict({ decision: "block" }), digest, events: [] }).outcome).toBe("block");
    const pending = verdict({ decision: "pending", reason: "seat outage" });
    expect(toCliResult({ verdict: pending, digest, events: [] })).toMatchObject({
      outcome: "pending",
      reason: "seat outage",
    });
    const change = makeChange();
    const budget = toCliResult({
      verdict: pending,
      digest,
      events: [
        {
          type: "budget-blocked",
          change,
          tier: pending.tier,
          reason: "per-change over",
          ceiling: "per-change",
          digest,
        },
      ],
    });
    expect(budget).toMatchObject({ outcome: "budget-blocked", reason: "per-change over" });
    // A decided stored verdict kept despite a budget refusal stays the signal.
    const kept = toCliResult({
      verdict: verdict({ decision: "block" }),
      digest,
      events: [{ type: "budget-blocked", change, tier: pending.tier, reason: "x", ceiling: "per-change", digest }],
      pendingReason: "x",
    });
    expect(kept.outcome).toBe("block");
  });

  it("maps estimates, taking per-seat dollars from the per-seat ceiling rows", () => {
    const seat = {
      id: "h1",
      role: "hunter" as const,
      lens: "correctness",
      model: { connectionId: "c", provider: "p", name: "m" },
      budget: { maxTurns: 50, deadlineMs: 1000 },
    };
    const row = (ceiling: "per-seat" | "per-change", extra = {}) => ({
      ceiling,
      limitUsd: 25,
      currentUsd: 0,
      projectedUsd: 0.5,
      breached: false,
      fraction: 0.02,
      ...extra,
    });
    const e = toCliEstimate({
      change: makeChange(),
      tier: verdict().tier,
      triage: { decision: "review", reason: "big" },
      seats: [seat],
      secondJudgeRound: false,
      estimateUsd: 0.5,
      unknownSeats: [],
      ceilings: [row("per-seat", { seatId: "h1" }), row("per-change")],
      round: 1,
      diffOnly: false,
      budgetBlocked: { ceiling: "per-change", message: "nope" },
      summary: "",
    });
    expect(e).toMatchObject({
      seats: [{ id: "h1", model: "m", connectionId: "c", usd: 0.5 }],
      usd: 0.5,
      admitted: false,
      blockedReason: "nope",
    });
    expect(e.ceilings.map((c) => c.ceiling)).toEqual(["per-change"]);
  });
});

describe("cost heuristics", () => {
  it("picks mid hunters and the strongest judge, and grows cost with tier", () => {
    const models = [model("small-1", "small"), model("big", "frontier"), model("mid-1", "mid")];
    expect(autoModels(models)).toMatchObject({ hunter: { name: "mid-1" }, judge: { name: "big" } });
    const [t1, t2, t3] = tierCosts(models);
    expect(t1?.hunters).toBe(2);
    expect(t3?.judges).toBe(2);
    expect((t1?.usd ?? 0) < (t2?.usd ?? 0) && (t2?.usd ?? 0) < (t3?.usd ?? 0)).toBe(true);
    expect(seatTokens("judge", 300, DEFAULT_POLICY, true).in).toBeGreaterThan(seatTokens("judge", 300).in);
    expect(seatTokens("hunter", 3000).in).toBeGreaterThan(seatTokens("hunter", 300).in);
    const unpriced = tierCosts([{ ...model("mystery", "mid", "openai-compatible"), pricing: undefined }]);
    expect(unpriced[0]?.pessimistic).toBe(true);
    expect(tierCosts([]).every((c) => c.usd === 0)).toBe(true);
  });
});
