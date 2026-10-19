import { describe, expect, it } from "vitest";
import { makeCaseResult, makeSuiteResult } from "../test/helpers.js";
import { evaluateBreakers } from "./breakers.js";

const caught = (id: string, tier: 0 | 1 | 2 | 3) =>
  makeCaseResult({ id, expected: { decision: "block", tier }, actual: { decision: "block", tier } });
const missed = (id: string, tier: 0 | 1 | 2 | 3, triage: "auto-pass" | "review" = "review") =>
  makeCaseResult({
    id,
    expected: { decision: "block", tier },
    actual: { decision: "pass", tier, triage },
    passed: false,
  });
const clean = (id: string, blocked: boolean) =>
  makeCaseResult({
    id,
    kind: "clean",
    expected: { decision: "pass" },
    actual: { decision: blocked ? "block" : "pass", tier: 1 },
    passed: !blocked,
  });

describe("evaluateBreakers", () => {
  it("is quiet when everything is within thresholds", () => {
    const r = evaluateBreakers(makeSuiteResult([caught("a", 3), clean("c", false)]));
    expect(r).toEqual({ reasons: ["all breakers within thresholds"] });
  });

  it("suggests widening triage when the false-block rate is too high", () => {
    const r = evaluateBreakers(makeSuiteResult([caught("a", 3), clean("c1", true), clean("c2", false)]));
    expect(r.widenTriage).toBe(true);
    expect(r.reasons[0]).toMatch(/false-block rate 50% on 2 clean case\(s\) exceeds 10%.*c1 \(tier 1\)/);
  });

  it("suggests raising quorum for the tiers whose recall is below threshold", () => {
    const r = evaluateBreakers(
      makeSuiteResult([caught("a", 3), missed("b", 3), caught("c", 1), missed("d", 2), caught("e", 2), caught("f", 2)]),
      { minRecall: 0.7 },
    );
    expect(r.raiseQuorumTier).toBe(3);
    expect(r.raiseQuorumTiers).toEqual([3, 2]);
    expect(r.reasons.join("\n")).toMatch(/tier 3: incident recall 50% \(1\/2\) is below 70%: raise quorum.t3/);
  });

  it("suggests narrowing triage instead when misses never reached a reviewer", () => {
    const r = evaluateBreakers(makeSuiteResult([missed("a", 0, "auto-pass"), caught("b", 0)]));
    expect(r.narrowTriage).toBe(true);
    expect(r.raiseQuorumTier).toBeUndefined();
  });

  it("respects the minimum evidence per tier and never runs on dry results", () => {
    const thin = evaluateBreakers(makeSuiteResult([missed("a", 2)]), { minIncidentsPerTier: 2 });
    expect(thin.raiseQuorumTier).toBeUndefined();
    const dry = evaluateBreakers(makeSuiteResult([missed("a", 2)], { dry: true }));
    expect(dry.reasons[0]).toMatch(/dry run/);
  });
});
