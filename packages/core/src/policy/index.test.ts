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
