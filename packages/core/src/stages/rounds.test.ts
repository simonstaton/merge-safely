import { describe, expect, it } from "vitest";
import type { Finding, Verdict } from "../types.js";
import { aggregate } from "./aggregate.js";
import { assignFingerprints } from "./fingerprint.js";
import { applyJudgeVotes } from "./judge.js";
import { canAcceptVerdict, openFindings, planRound, reconcileRounds, reviewedCode } from "./rounds.js";
import { makeAudit, makeChange, makeFinding, makePolicy, makeRun, makeTier, makeVerdict } from "./test-helpers.js";

const policy = makePolicy();
const change = makeChange({ headSha: "c3" });
const [F1, F2, F3] = assignFingerprints([
  makeFinding({ title: "First", severity: "blocker", file: "src/a.ts" }),
  makeFinding({ title: "Second", severity: "important", file: "src/b.ts" }),
  makeFinding({ title: "Third", severity: "nit", file: "src/c.ts" }),
]) as [Finding, Finding, Finding];
const reviewed = (o: Partial<Verdict>) => makeVerdict({ seats: [makeRun()], ...o });

describe("reviewedCode", () => {
  it("accepts only decided, untriaged, uncontested verdicts with a completed hunter", () => {
    expect(reviewedCode(reviewed({ decision: "block" }))).toBe(true);
    expect(reviewedCode(reviewed({ decision: "pending" }))).toBe(false);
    expect(reviewedCode(reviewed({ contested: true }))).toBe(false);
    expect(reviewedCode(makeVerdict({ triaged: true }))).toBe(false);
    expect(reviewedCode(makeVerdict({ seats: [] }))).toBe(false);
    expect(reviewedCode(makeVerdict({ seats: [makeRun({ status: "error", output: null })] }))).toBe(false);
  });
});

describe("openFindings", () => {
  it("unions open findings across verdicts, closing addressed ones, latest severity wins", () => {
    const open = openFindings([
      reviewed({ round: 2, findings: [{ ...F2, severity: "nit" }], addressed: [F3.id] }),
      reviewed({ round: 1, findings: [F1, F2, F3] }),
    ]);
    expect(open.map((f) => [f.id, f.severity])).toEqual([
      [F1.id, "blocker"],
      [F2.id, "nit"],
    ]);
  });

  it("is cleared by a human pass", () => {
    const open = openFindings([
      reviewed({ round: 1, findings: [F1] }),
      makeVerdict({ kind: "human", decision: "pass", round: 1, createdAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(open).toEqual([]);
  });
});

describe("planRound", () => {
  it("starts at round 1 with the full diff", () => {
    expect(planRound({ change, priorVerdicts: [], policy })).toEqual({
      round: 1,
      knownFindings: [],
      diffOnly: false,
      capReached: false,
    });
  });

  it("continues from the latest reviewed machine verdict and knows every open finding", () => {
    const priors = [
      reviewed({ round: 1, headSha: "c1", findings: [F1, F2] }),
      reviewed({ round: 2, headSha: "c2", findings: [F3] }),
      makeVerdict({ round: 7, number: 99, findings: [makeFinding({ file: "other.ts" })] }),
    ];
    const plan = planRound({ change, priorVerdicts: priors, policy });
    expect(plan).toMatchObject({ round: 3, sinceSha: "c2", diffOnly: true, capReached: false });
    expect(plan.knownFindings.map((f) => f.id).sort()).toEqual([F1.id, F2.id, F3.id].sort());
  });

  it("reviews from base when the prior verdict did not review code", () => {
    for (const prior of [
      makeVerdict({
        round: 1,
        headSha: "c1",
        decision: "pending",
        seats: [makeRun({ status: "error", output: null })],
      }),
      makeVerdict({ round: 1, headSha: "c1", triaged: true }),
      reviewed({ round: 1, headSha: "c1", decision: "block", contested: true, findings: [F1] }),
    ]) {
      const plan = planRound({ change, priorVerdicts: [prior], policy });
      expect(plan.diffOnly).toBe(false);
      expect(plan.sinceSha).toBeUndefined();
      expect(plan.round).toBe(2);
    }
    const contested = reviewed({ round: 1, headSha: "c1", contested: true, findings: [F1] });
    expect(planRound({ change, priorVerdicts: [contested], policy }).knownFindings.map((f) => f.id)).toEqual([F1.id]);
  });

  it("reports the cap and respects diffOnlyAfterRound", () => {
    const priors = [
      reviewed({ round: 1, headSha: "c0" }),
      reviewed({ round: 2, headSha: "c1" }),
      reviewed({ round: 3, headSha: "c2" }),
    ];
    expect(planRound({ change, priorVerdicts: priors, policy }).capReached).toBe(true);
    const late = makePolicy({ rounds: { diffOnlyAfterRound: 5 } });
    expect(planRound({ change, priorVerdicts: priors, policy: late })).toMatchObject({ round: 4, diffOnly: false });
  });

  it("does not let outages consume the round cap", () => {
    const outage = (round: number, headSha: string) =>
      makeVerdict({ round, headSha, decision: "pending", seats: [makeRun({ status: "error", output: null })] });
    const history = [
      outage(1, "s1"),
      outage(2, "s2"),
      reviewed({ round: 3, headSha: "s3", decision: "block" }),
      reviewed({ round: 4, headSha: "s4", decision: "block" }),
      reviewed({ round: 5, headSha: "s5", decision: "block" }),
    ];
    const capAfter = (n: number) => planRound({ change, priorVerdicts: history.slice(0, n), policy });
    expect([1, 2, 3, 4].map((n) => capAfter(n).capReached)).toEqual([false, false, false, false]);
    const third = capAfter(5);
    expect(third).toMatchObject({ round: 6, capReached: true });
  });

  it("counts reviewed re-runs of the same commit once, and ignores triaged and contested verdicts", () => {
    const history = [
      reviewed({ round: 1, headSha: "s1" }),
      reviewed({ round: 2, headSha: "s1" }),
      reviewed({ round: 3, headSha: "s1" }),
      makeVerdict({ round: 4, headSha: "s2", triaged: true }),
      reviewed({ round: 5, headSha: "s3", contested: true }),
      reviewed({ round: 6, headSha: "s4" }),
    ];
    const plan = planRound({ change, priorVerdicts: history, policy });
    expect(plan).toMatchObject({ round: 7, capReached: false });
    const plan2 = planRound({ change, priorVerdicts: [...history, reviewed({ round: 7, headSha: "s5" })], policy });
    expect(plan2.capReached).toBe(true);
  });

  it("uses the full diff when re-running on the same head", () => {
    const priors = [reviewed({ round: 1, headSha: "c3" })];
    expect(planRound({ change, priorVerdicts: priors, policy })).toMatchObject({ round: 2, diffOnly: false });
  });
});

describe("reconcileRounds", () => {
  const run = (addressed: string[], findings: Finding[] = [], extra = {}) =>
    makeRun({ output: { verdict: findings.length ? "block" : "pass", addressed, findings }, ...extra });

  it("addresses a blocker only with a strict majority of attested hunters", () => {
    expect(reconcileRounds([F1], [run([F1.id]), run([F1.id]), run([])], [], policy)).toEqual({
      addressed: [F1.id],
      carried: [],
    });
    expect(reconcileRounds([F1], [run([F1.id]), run([]), run([])], [], policy)).toEqual({
      addressed: [],
      carried: [F1.id],
    });
    // 1 of 7 is not enough.
    const seven = [run([F1.id]), ...Array.from({ length: 6 }, () => run([]))];
    expect(reconcileRounds([F1], seven, [], policy).carried).toEqual([F1.id]);
  });

  it("addresses a nit with a single attested listing", () => {
    expect(reconcileRounds([F3], [run([F3.id]), run([]), run([])], [], policy)).toEqual({
      addressed: [F3.id],
      carried: [],
    });
  });

  it("carries anything re-raised or surviving, whatever the majority says", () => {
    const all = [run([F1.id]), run([F1.id]), run([F1.id], [{ ...F1, id: "", line: 7 }])];
    expect(reconcileRounds([F1], all, [], policy).carried).toEqual([F1.id]);
    expect(reconcileRounds([F1], [run([F1.id]), run([F1.id])], [F1], policy).carried).toEqual([F1.id]);
  });

  it("never counts insufficient-work or failed runs", () => {
    const lazy = run([F3.id], [], { audit: makeAudit({ substantiveCalls: 0 }) });
    expect(reconcileRounds([F3], [lazy], [], policy)).toEqual({ addressed: [], carried: [F3.id] });
    const failed = makeRun({ status: "timeout", output: null });
    expect(reconcileRounds([F1], [failed], [], policy)).toEqual({ addressed: [], carried: [F1.id] });
  });
});

describe("carried blockers across rounds", () => {
  it("A blocks on X; a diff-only push B keeps blocking; round 3 still knows X", () => {
    const tier = makeTier({ level: 1 });
    const X = makeFinding({
      severity: "blocker",
      class: "logic-error",
      title: "Drops writes",
      file: "src/x.ts",
      line: 5,
    });
    const changeA = makeChange({ headSha: "A" });
    const changeB = makeChange({ headSha: "B" });
    const changeC = makeChange({ headSha: "C" });

    // Round 1 on A: one hunter blocks on X, the judge confirms.
    const plan1 = planRound({ change: changeA, priorVerdicts: [], policy });
    const r1runs = [makeRun({ headSha: "A", output: { verdict: "block", findings: [X] } })];
    const [xCandidate] = assignFingerprints([X]) as [Finding];
    const judge1 = applyJudgeVotes([xCandidate], [], policy);
    const agg1 = aggregate({ tier, hunterRuns: r1runs, judgeRuns: [], judge: judge1, carried: [], policy });
    expect(agg1.decision).toBe("block");
    const v1 = reviewed({
      headSha: "A",
      round: plan1.round,
      decision: agg1.decision,
      findings: agg1.findings,
      seats: r1runs,
    });

    // Round 2 on B: diff-only, hunters were told not to repeat X; none re-raise it or claim it addressed.
    const plan2 = planRound({ change: changeB, priorVerdicts: [v1], policy });
    expect(plan2).toMatchObject({ round: 2, diffOnly: true, sinceSha: "A" });
    expect(plan2.knownFindings.map((f) => f.id)).toEqual([xCandidate.id]);
    const r2runs = [makeRun({ headSha: "B" }), makeRun({ headSha: "B" })];
    const judge2 = applyJudgeVotes([], [], policy);
    const rec2 = reconcileRounds(plan2.knownFindings, r2runs, judge2.surviving, policy);
    expect(rec2.carried).toEqual([xCandidate.id]);
    const carried2 = plan2.knownFindings.filter((f) => rec2.carried.includes(f.id));
    const agg2 = aggregate({ tier, hunterRuns: r2runs, judgeRuns: [], judge: judge2, carried: carried2, policy });
    expect(agg2.decision).toBe("block");
    const v2 = reviewed({
      headSha: "B",
      round: plan2.round,
      decision: agg2.decision,
      findings: agg2.findings,
      seats: r2runs,
      ...rec2,
    });

    // Round 3 on C still knows X.
    const plan3 = planRound({ change: changeC, priorVerdicts: [v1, v2], policy });
    expect(plan3.round).toBe(3);
    expect(plan3.knownFindings.map((f) => f.id)).toEqual([xCandidate.id]);
  });
});

describe("canAcceptVerdict", () => {
  const storedBlock = makeVerdict({ decision: "block", round: 1, findings: [F1, F3] });

  it("accepts with nothing stored or a different SHA", () => {
    expect(canAcceptVerdict(null, makeVerdict())).toEqual({ ok: true });
    expect(canAcceptVerdict(storedBlock, makeVerdict({ headSha: "other", round: 2 }))).toEqual({ ok: true });
  });

  it("never lets a same-SHA machine pass replace a machine block, even with addressed claims", () => {
    for (const incoming of [
      makeVerdict({ decision: "pass", round: 2, addressed: [] }),
      makeVerdict({ decision: "pass", round: 2, addressed: [F1.id, F3.id] }),
      makeVerdict({ decision: "pending", round: 2 }),
    ]) {
      const r = canAcceptVerdict(storedBlock, incoming);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.contested).toBe(true);
      expect(!r.ok && r.reason).toContain(F1.id);
      expect(!r.ok && r.reason).not.toContain(F3.id);
    }
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
