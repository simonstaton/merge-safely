import { describe, expect, it } from "vitest";
import { makeCaseResult, makeSuiteResult } from "../test/helpers.js";
import { compareReports, exitCodeFor, percentile, renderComparison, renderReport } from "./report.js";

const incidentCaught = makeCaseResult({
  id: "inc-1",
  expected: { decision: "block", tier: 3, findingClasses: ["lock-risk"] },
  actual: {
    decision: "block",
    findings: [
      { class: "lock-risk", severity: "blocker", file: "a.ts", lens: "perf", lenses: ["perf"], models: ["model-a"] },
      { class: "missing-flag", severity: "important", lens: "rollout", lenses: ["rollout"], models: ["model-b"] },
    ],
    models: ["model-a", "model-b"],
    cost: { usd: 2 },
  },
  durationMs: 300,
});
const incidentMissed = makeCaseResult({
  id: "inc-2",
  expected: { decision: "block", tier: 3 },
  actual: { decision: "pass", tier: 2, cost: { usd: 1 } },
  passed: false,
  reasons: ["expected tier 3, got tier 2", "expected block, got pass"],
  durationMs: 100,
});
const cleanPass = makeCaseResult({
  id: "clean-1",
  kind: "clean",
  expected: { decision: "pass", tier: 0 },
  actual: { decision: "pass", tier: 0, triage: "auto-pass", seats: 0, lenses: [], models: [], cost: {} },
  durationMs: 10,
});
const cleanBlocked = makeCaseResult({
  id: "clean-2",
  kind: "clean",
  expected: { decision: "pass" },
  actual: {
    decision: "block",
    tier: 1,
    lenses: ["correctness"],
    models: ["model-b"],
    findings: [
      { class: "logic-error", severity: "blocker", lens: "correctness", lenses: ["correctness"], models: ["model-b"] },
    ],
    cost: { usd: 0.5 },
  },
  passed: false,
  reasons: ["expected pass, got block"],
  durationMs: 1000,
});

const result = makeSuiteResult([incidentCaught, incidentMissed, cleanPass, cleanBlocked]);

describe("summarize", () => {
  it("computes recall, false-block rate, tier accuracy, cost and durations", () => {
    const s = result.summary;
    expect(s).toMatchObject({
      total: 4,
      passed: 2,
      incidents: 2,
      incidentsBlocked: 1,
      recall: 0.5,
      clean: 2,
      cleanBlocked: 1,
      falseBlockRate: 0.5,
      tierChecked: 3,
      tierCorrect: 2,
    });
    expect(s.tierAccuracy).toBeCloseTo(2 / 3);
    expect(s.cost).toMatchObject({ totalUsd: 3.5, unpriced: 1, perCase: { "clean-1": null, "inc-1": 2 } });
    expect(s.durationMs).toEqual({ total: 1410, p50: 100, p95: 1000 });
    // Keyed by the actual tier: inc-2 was tiered 2 although it expected 3.
    expect(s.perTier["3"]).toEqual({ incidents: 1, blocked: 1, underTiered: 0, recall: 1, missedByTriage: 0 });
    expect(s.perTier["2"]).toEqual({ incidents: 1, blocked: 0, underTiered: 1, recall: 0, missedByTriage: 0 });
    expect(s.ok).toBe(false);
    expect(s.gateFailures).toEqual([
      "2 case(s) failed: inc-2, clean-2",
      "recall 50% is below minRecall 80%",
      "false-block rate 50% is above maxFalseBlock 10%",
    ]);
    expect(exitCodeFor(result)).toBe(1);
  });

  it("attributes catches and false blocks per lens and per model", () => {
    const { perLens, perModel } = result.summary;
    expect(perLens.perf).toMatchObject({ seated: 2, incidentsSeated: 2, incidentsCaught: 1, recall: 0.5, findings: 1 });
    // rollout raised a finding, but not the expected class.
    expect(perLens.rollout).toMatchObject({ incidentsCaught: 0, findings: 1 });
    expect(perLens.correctness).toMatchObject({ cleanSeated: 1, cleanBlocks: 1, falseBlockRate: 1 });
    expect(perModel["model-a"]).toMatchObject({ incidentsCaught: 1, incidentsSeated: 2 });
    expect(perModel["model-b"]).toMatchObject({ incidentsCaught: 0, cleanBlocks: 1, falseBlockRate: 1 });
  });

  it("passes the gates when everything holds and fails on a regression", () => {
    const ok = makeSuiteResult([incidentCaught, cleanPass]);
    expect(ok.summary.ok).toBe(true);
    expect(exitCodeFor(ok)).toBe(0);
    const reg = makeSuiteResult([incidentCaught, makeCaseResult({ id: "r", kind: "regression", passed: false })]);
    expect(reg.summary.gateFailures).toEqual(["1 case(s) failed: r"]);
  });

  it("nulls rates in dry mode and fails on any failed case", () => {
    const dry = makeSuiteResult([cleanPass, incidentMissed], { dry: true });
    expect(dry.summary).toMatchObject({ recall: null, falseBlockRate: null, perLens: {}, ok: false });
    expect(dry.summary.gateFailures[0]).toMatch(/failed dry-run checks: inc-2/);
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});

describe("renderReport", () => {
  it("renders text with headline, cases, failures and attribution", () => {
    const text = renderReport(result, "text");
    expect(text).toContain("FAILED: 2/4 cases passed");
    expect(text).toContain(
      "Recall (incidents caught for the expected reason): 1/2 = 50% (min 80%); 1 blocked for any reason",
    );
    expect(text).toContain("Unresolved (error, pending or contested): 0");
    expect(text).toContain("False-block rate (clean blocked): 1/2 = 50% (max 10%)");
    expect(text).toMatch(/FAIL\s+inc-2\s+incident\s+block t3\s+pass t2/);
    expect(text).toContain("    - expected block, got pass");
    expect(text).toMatch(/Per lens\nlens\s+seated/);
    expect(text).toMatch(/model-a\s+2\s+1\/2\s+50%/);
  });

  it("renders markdown tables", () => {
    const md = renderReport(result, "markdown");
    expect(md).toContain("## Eval suite: s");
    expect(md).toContain("| result | case | kind | expected | actual | triage | seats | cost | time |");
    expect(md).toContain("| FAIL | clean-2 | clean | pass | block t1 | review | 2 | $0.50 | 1.0s |");
    expect(md).toContain("### Per model");
    expect(md).toContain("**Gate failures**");
  });

  it("renders json that round-trips", () => {
    const parsed: unknown = JSON.parse(renderReport(result, "json"));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("says when a run was dry", () => {
    expect(renderReport(makeSuiteResult([cleanPass], { dry: true }), "text")).toContain("dry run");
  });
});

describe("compareReports", () => {
  it("reports fixed, regressed, changed, added and removed cases with deltas", () => {
    const before = makeSuiteResult([incidentCaught, incidentMissed, cleanPass, cleanBlocked]);
    const after = makeSuiteResult([
      { ...incidentCaught, passed: false, actual: { ...incidentCaught.actual, decision: "pass" } },
      { ...incidentMissed, passed: true, actual: { ...incidentMissed.actual, decision: "block", tier: 3 } },
      { ...cleanBlocked, actual: { ...cleanBlocked.actual, tier: 2 } },
      makeCaseResult({ id: "new-1" }),
    ]);
    const cmp = compareReports(before, after);
    expect(cmp.regressed).toEqual(["inc-1"]);
    expect(cmp.fixed).toEqual(["inc-2"]);
    expect(cmp.flips.find((f) => f.id === "clean-2")).toMatchObject({
      change: "changed",
      before: { tier: 1 },
      after: { tier: 2 },
    });
    expect(cmp.added).toEqual(["new-1"]);
    expect(cmp.removed).toEqual(["clean-1"]);
    expect(cmp.delta.recall).toBeCloseTo(2 / 3 - 1 / 2);
    const text = renderComparison(cmp);
    expect(text).toContain("REGRESSED inc-1 (incident): block t3 -> pass t3");
    expect(text).toContain("FIXED inc-2 (incident): pass t2 -> block t3");
    expect(renderComparison(compareReports(before, before))).toContain("no case changed");
  });
});
