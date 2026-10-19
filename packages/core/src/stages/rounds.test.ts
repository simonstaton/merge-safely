import { describe, expect, it } from "vitest";
import type { Finding } from "../types.js";
import { assignFingerprints } from "./fingerprint.js";
import { canAcceptVerdict, planRound, reconcileRounds } from "./rounds.js";
import { makeChange, makeFinding, makePolicy, makeRun, makeVerdict } from "./test-helpers.js";

const policy = makePolicy();
const change = makeChange({ headSha: "c3" });
const [F1, F2] = assignFingerprints([
  makeFinding({ title: "First", severity: "blocker" }),
  makeFinding({ title: "Second", file: "src/b.ts" }),
]) as [Finding, Finding];

describe("planRound", () => {
  it("starts at round 1 with the full diff", () => {
    expect(planRound({ change, priorVerdicts: [], policy })).toEqual({
      round: 1,
      knownFindings: [],
      diffOnly: false,
      capReached: false,
    });
  });

  it("continues from the latest machine verdict for the same change", () => {
    const priors = [
      makeVerdict({ round: 1, headSha: "c1", findings: [F1, F2] }),
      makeVerdict({ round: 2, headSha: "c2", findings: [F2] }),
      makeVerdict({ round: 9, headSha: "c2", kind: "human" }),
      makeVerdict({ round: 7, number: 99 }),
    ];
    expect(planRound({ change, priorVerdicts: priors, policy })).toEqual({
      round: 3,
      knownFindings: [F2],
      sinceSha: "c2",
      diffOnly: true,
      capReached: false,
    });
  });

  it("reports the cap and respects diffOnlyAfterRound", () => {
    const priors = [makeVerdict({ round: 3, headSha: "c2" })];
    expect(planRound({ change, priorVerdicts: priors, policy }).capReached).toBe(true);
    const late = makePolicy({ rounds: { diffOnlyAfterRound: 5 } });
    expect(planRound({ change, priorVerdicts: priors, policy: late })).toMatchObject({ round: 4, diffOnly: false });
    expect(planRound({ change, priorVerdicts: priors, policy: late }).sinceSha).toBeUndefined();
  });

  it("uses the full diff when re-running on the same head", () => {
    const priors = [makeVerdict({ round: 1, headSha: "c3" })];
    expect(planRound({ change, priorVerdicts: priors, policy })).toMatchObject({ round: 2, diffOnly: false });
  });
});

describe("reconcileRounds", () => {
  const run = (addressed: string[], findings: Finding[] = []) =>
    makeRun({ output: { verdict: findings.length ? "block" : "pass", addressed, findings } });

  it("addresses by majority even if someone re-raised", () => {
    const r = reconcileRounds([F1], [run([F1.id]), run([F1.id]), run([], [{ ...F1, id: "" }])], []);
    expect(r).toEqual({ addressed: [F1.id], carried: [] });
  });

  it("addresses by a single listing when nobody re-raised", () => {
    const r = reconcileRounds([F1, F2], [run([F1.id]), run([]), run([])], []);
    expect(r).toEqual({ addressed: [F1.id], carried: [F2.id] });
  });

  it("carries a minority listing that was re-raised or survived", () => {
    expect(reconcileRounds([F1], [run([F1.id]), run([], [{ ...F1, line: 12 - 3 }]), run([])], [])).toEqual({
      addressed: [],
      carried: [F1.id],
    });
    expect(reconcileRounds([F1], [run([F1.id]), run([]), run([])], [F1])).toEqual({ addressed: [], carried: [F1.id] });
  });

  it("ignores failed runs and carries everything with no ok hunters", () => {
    const failed = makeRun({ status: "timeout", output: null });
    expect(reconcileRounds([F1], [failed], [])).toEqual({ addressed: [], carried: [F1.id] });
  });
});

describe("canAcceptVerdict", () => {
  const storedBlock = makeVerdict({ decision: "block", round: 1, findings: [F1, { ...F2, severity: "nit" }] });

  it("accepts with nothing stored or a different SHA", () => {
    expect(canAcceptVerdict(null, makeVerdict())).toEqual({ ok: true });
    expect(canAcceptVerdict(storedBlock, makeVerdict({ headSha: "other", round: 2 }))).toEqual({ ok: true });
  });

  it("rejects a pass over an unresolved block for the same SHA", () => {
    const r = canAcceptVerdict(storedBlock, makeVerdict({ decision: "pass", round: 2, addressed: [] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(F1.id);
    expect(!r.ok && r.reason).not.toContain(F2.id);
    expect(canAcceptVerdict(storedBlock, makeVerdict({ decision: "pending", round: 2 })).ok).toBe(false);
  });

  it("accepts a pass once every blocker/important finding is addressed", () => {
    expect(canAcceptVerdict(storedBlock, makeVerdict({ decision: "pass", round: 2, addressed: [F1.id] }))).toEqual({
      ok: true,
    });
  });

  it("lets human verdicts replace machine ones but not the reverse", () => {
    expect(canAcceptVerdict(storedBlock, makeVerdict({ kind: "human", decision: "pass", round: 1 }))).toEqual({
      ok: true,
    });
    const human = makeVerdict({ kind: "human", decision: "block" });
    expect(canAcceptVerdict(human, makeVerdict({ round: 2 })).ok).toBe(false);
  });

  it("is idempotent for the same round and decision, and rejects stale rounds", () => {
    expect(canAcceptVerdict(storedBlock, makeVerdict({ decision: "block", round: 1 }))).toEqual({ ok: true });
    const stored = makeVerdict({ decision: "pass", round: 3 });
    expect(canAcceptVerdict(stored, makeVerdict({ decision: "block", round: 2 })).ok).toBe(false);
    expect(canAcceptVerdict(stored, makeVerdict({ decision: "block", round: 4 }))).toEqual({ ok: true });
  });
});
