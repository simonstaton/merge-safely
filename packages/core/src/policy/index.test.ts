import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parsePolicy, policyHash } from "./index.js";

describe("policy", () => {
  it("hashes stably", () => {
    expect(policyHash(DEFAULT_POLICY)).toHaveLength(16);
    const r = parsePolicy({ tiers: { thresholds: { t1: 10 } } });
    expect(r.ok && r.policy.tiers.thresholds.t1).toBe(10);
  });
  it("rejects unknown keys", () => {
    expect(parsePolicy({ bogus: 1 }).ok).toBe(false);
  });
});

describe("policy strictness", () => {
  it("rejects unknown keys inside sections so typos cannot silently disable rules", () => {
    expect(parsePolicy({ tiers: { criticalPath: ["x"] } }).ok).toBe(false);
    expect(parsePolicy({ quorum: { t4: 1 } }).ok).toBe(false);
    expect(parsePolicy({ panel: { t1: { hunters: ["correctness"], judge: 1 } } }).ok).toBe(false);
    expect(parsePolicy({ models: { hunters: { connection: "a", model: "b", efort: "x" } } }).ok).toBe(false);
  });

  it("rejects the removed keys trust.provider codeowners and rounds.neverRepeatFindings", () => {
    expect(parsePolicy({ trust: { provider: "codeowners" } }).ok).toBe(false);
    expect(parsePolicy({ rounds: { neverRepeatFindings: true } }).ok).toBe(false);
    for (const provider of ["none", "github-teams", "allowlist"]) {
      expect(parsePolicy({ trust: { provider } }).ok).toBe(true);
    }
    expect(DEFAULT_POLICY.rounds).toEqual({ max: 3, diffOnlyAfterRound: 1 });
  });
});
