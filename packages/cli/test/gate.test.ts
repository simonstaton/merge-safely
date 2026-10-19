import * as core from "@merge-safely/core";
import { DEFAULT_POLICY, policyHash } from "@merge-safely/core";
import { createProviderRegistry } from "@merge-safely/providers";
import { describe, expect, it } from "vitest";
import { autoModels, seatTokens, tierCosts } from "../src/cost.js";
import { adaptGate, buildGateDeps, realGateFactory, registryPricing, toCliEstimate, toCliResult } from "../src/gate.js";
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

  it("the production factory reports a clear error until the core exports createGate", async () => {
    const hasGate = typeof (core as Record<string, unknown>).createGate === "function";
    const f = realGateFactory(() => createProviderRegistry([fakeProvider()]));
    if (hasGate) await expect(f(setup({ mode: "local", root: "/tmp" }))).resolves.toBeDefined();
    else await expect(f(setup({ mode: "local", root: "/tmp" }))).rejects.toMatchObject({ code: "GATE_UNAVAILABLE" });
  });

  it("registry pricing steps down within the connection's catalog", () => {
    const models = [model("claude-opus-5-5", "frontier"), model("claude-sonnet-5-5", "mid")];
    const p = registryPricing(() => models);
    const next = p.cheaper({ connectionId: "c", provider: "anthropic", name: "claude-opus-5-5" });
    expect(next).toEqual({ connectionId: "c", provider: "anthropic", name: "claude-sonnet-5-5" });
    expect(p.cheaper({ connectionId: "c", provider: "anthropic", name: "unknown" })).toBeUndefined();
    expect(p.price(model("x", "mid"), { in: 1_000_000, out: 0 }).usd).toBe(3);
  });
});

describe("result normalisation", () => {
  it("maps verdicts, contested and budget-blocked results", () => {
    const pass = toCliResult(
      { verdict: verdict(), digest: { headline: "h", markdown: "m", text: "t" } },
      DEFAULT_POLICY,
    );
    expect(pass).toMatchObject({ outcome: "pass", digest: { text: "t" } });
    expect(toCliResult({ verdict: verdict({ contested: true }) }, DEFAULT_POLICY).outcome).toBe("contested");
    const blocked = toCliResult({ verdict: verdict({ decision: "block" }) }, DEFAULT_POLICY);
    expect(blocked.outcome).toBe("block");
    expect(blocked.digest.text).toContain("BLOCK");
    expect(toCliResult({ status: "budget-blocked", reason: "per-change" }, DEFAULT_POLICY)).toMatchObject({
      outcome: "budget-blocked",
      reason: "per-change",
    });
    expect(toCliResult(undefined, DEFAULT_POLICY).outcome).toBe("error");
  });

  it("maps estimates defensively", () => {
    const e = toCliEstimate({
      tier: { level: 2, score: 50, factors: { loc: 1, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
      seats: [
        { id: "h1", role: "hunter", lens: "correctness", model: { connectionId: "c", provider: "p", name: "m" } },
      ],
      perSeatUsd: { h1: 0.5 },
      usd: 0.5,
      ceilings: [{ ceiling: "per-change", limitUsd: 25, currentUsd: 0, projectedUsd: 0.5, breached: false }],
      admission: { ok: false, message: "nope" },
    });
    expect(e).toMatchObject({
      seats: [{ id: "h1", model: "m", connectionId: "c", usd: 0.5 }],
      usd: 0.5,
      admitted: false,
      blockedReason: "nope",
    });
    expect(toCliEstimate(null).seats).toEqual([]);
  });

  it("adapts a core gate", async () => {
    const v = verdict();
    const g = adaptGate(
      {
        review: async () => ({ verdict: v }),
        reviewChange: async () => ({ verdict: v }),
        estimate: async () => ({}),
        explain: async () => null,
        recordHumanVerdict: async () => v,
      },
      DEFAULT_POLICY,
    );
    expect((await g.review({ repo: v.repo, number: 1 }, {})).outcome).toBe("pass");
    expect(await g.explain({ repo: v.repo, number: 1 })).toBeNull();
    expect(
      (
        await g.recordHumanVerdict({
          ref: { repo: v.repo, number: 1 },
          headSha: "a",
          decision: "pass",
          signedBy: { kind: "human", login: "x" },
          reason: "r",
        })
      ).decision,
    ).toBe("pass");
  });
});

describe("cost heuristics", () => {
  it("picks mid hunters and the strongest judge, and grows cost with tier", () => {
    const models = [model("small-1", "small"), model("big", "frontier"), model("mid-1", "mid")];
    expect(autoModels(models)).toMatchObject({ hunter: { name: "mid-1" }, judge: { name: "big" } });
    const [t1, t2, t3] = tierCosts(models);
    expect(t1?.hunters).toBe(2);
    expect(t3?.judges).toBe(4);
    expect((t1?.usd ?? 0) < (t2?.usd ?? 0) && (t2?.usd ?? 0) < (t3?.usd ?? 0)).toBe(true);
    expect(seatTokens("hunter", 300).in).toBeGreaterThan(seatTokens("judge", 300).in);
    const unpriced = tierCosts([{ ...model("mystery", "mid", "openai-compatible"), pricing: undefined }]);
    expect(unpriced[0]?.pessimistic).toBe(true);
    expect(tierCosts([]).every((c) => c.usd === 0)).toBe(true);
  });
});
