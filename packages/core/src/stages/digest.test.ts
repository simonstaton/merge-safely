import { describe, expect, it } from "vitest";
import type { Finding } from "../types.js";
import { MAX_DIGEST_CHARS, renderBudgetBlockedDigest, renderDigest, renderPendingDigest } from "./digest.js";
import { makeAudit, makeFinding, makePolicy, makeRun, makeSeat, makeTier, makeVerdict } from "./test-helpers.js";

const policy = makePolicy();
const tier3 = makeTier({
  level: 3,
  score: 64,
  reasons: ["touches critical path **/jobs/**/backfill* (services/api/src/jobs/backfillJob.ts)"],
});
const findings: Finding[] = [
  makeFinding({
    id: "f3a9aaaaaa",
    severity: "blocker",
    class: "lock-risk",
    title: "Backfill scans a large table without batching",
    file: "services/api/src/jobs/backfillJob.ts",
    line: 41,
    evidence: ["ran EXPLAIN on the raw query; seq scan, no LIMIT"],
    suggestedFix: "batch by id ranges of 1000",
  }),
  makeFinding({ id: "b0000000001", severity: "important", title: "Missing index" }),
  makeFinding({ id: "c0000000001", severity: "nit", title: "Rename var", file: undefined }),
  makeFinding({ id: "d0000000001", severity: "pre-existing", title: "Old bug" }),
];
const seats = [
  makeRun({
    seatId: "hunter:perf:1",
    audit: makeAudit({ filesRead: ["a.ts", "b.ts"], commandsRun: ["npm test"] }),
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:02:10.000Z",
  }),
  makeRun({
    seat: {
      ...makeSeat({ id: "hunter:correctness:1" }),
      downgradedFrom: { connectionId: "c", provider: "anthropic", name: "big" },
    },
    audit: makeAudit({ filesRead: ["b.ts", "c.ts"], commandsRun: ["npm run lint", "git log"] }),
    status: "insufficient-work",
  }),
];
const verdict = makeVerdict({
  decision: "block",
  tier: tier3,
  round: 2,
  findings,
  seats,
  quorum: { required: 2, passed: 1, blocked: 2, invalid: 0 },
  addressed: ["aaaaaa1111", "bbbbbb2222"],
  carried: ["f3a9aaaaaa", "c17e000000"],
  downgrades: [{ step: "hunters-model", from: "big", to: "small", reason: "per-change ceiling" }],
  contested: true,
  escalated: true,
  cost: {
    usd: 1.84,
    tokens: { in: 123_400, out: 4_500 },
    bySeat: { "hunter:perf:1": { connectionId: "anthropic-main", model: "sonnet", usd: 1.2 } },
  },
});

describe("renderDigest", () => {
  const d = renderDigest(verdict, { policy });

  it("renders the headline with round of max", () => {
    expect(d.headline).toBe("Verdict: BLOCK (tier 3, round 2 of 3)");
    expect(renderDigest(verdict).headline).toBe("Verdict: BLOCK (tier 3, round 2)");
  });

  it("includes every section from design 4.3", () => {
    for (const out of [d.text]) {
      expect(out).toContain("Why tier 3: touches critical path **/jobs/**/backfill*");
      expect(out).toContain("2 required, 1 passed, 2 blocked, 0 invalid");
      expect(out).toContain("Blockers (1)");
      expect(out).toContain("Important (1)");
      expect(out).toContain("Nits (1)");
      expect(out).toContain("Pre-existing (1)");
      expect(out).toContain("services/api/src/jobs/backfillJob.ts:41");
      expect(out).toContain("Evidence: ran EXPLAIN on the raw query");
      expect(out).toContain("Suggested: batch by id ranges of 1000");
      expect(out).toContain("Addressed since round 1: 2 of 4 findings.");
      expect(out).toContain("Not addressed: #f3a9aa, #c17e00.");
      expect(out).toContain("3 files read, 3 commands");
      expect(out).toContain("1 pass rejected for insufficient work");
      expect(out).toContain("hunters-model (big → small): per-change ceiling");
      expect(out).toContain("hunter:correctness:1: big → model-a");
      expect(out).toContain("Contested");
      expect(out).toContain("Escalated");
      expect(out).toContain("$1.84");
      expect(out).toContain("123.4k tokens in / 4.5k out");
      expect(out).toContain("2 seats");
      expect(out).toContain("2m 10s");
      expect(out).toContain("hunter:perf:1 → anthropic-main/sonnet $1.20");
    }
    expect(d.markdown).toContain("### Blockers (1)");
    // Glob stars are escaped so GitHub does not render them as emphasis.
    expect(d.markdown).toContain("**Why tier 3:** touches critical path \\*\\*/jobs/\\*\\*/backfill\\*");
    expect(d.markdown).toContain("**Quorum:** 2 required, 1 passed, 2 blocked, 0 invalid");
    expect(d.markdown).toContain("`services/api/src/jobs/backfillJob.ts:41`");
    expect(d.markdown).toContain("**Addressed since round 1: 2 of 4 findings.** Not addressed: #f3a9aa, #c17e00.");
    expect(d.markdown).toContain("**Cost:** $1.84 · 123.4k tokens in / 4.5k out · 2 seats · 2m 10s");
  });

  it("orders severity groups", () => {
    const i = (s: string) => d.text.indexOf(s);
    expect(i("Blockers")).toBeLessThan(i("Important ("));
    expect(i("Important (")).toBeLessThan(i("Nits"));
    expect(i("Nits")).toBeLessThan(i("Pre-existing ("));
  });

  it("hides cost when the policy says so", () => {
    const hidden = renderDigest(verdict, { policy: makePolicy({ reporting: { showCostInSummary: false } }) });
    expect(hidden.markdown).not.toContain("$1.84");
  });

  it("neutralises markup and mentions in model text", () => {
    const evil = makeVerdict({
      findings: [makeFinding({ id: "e1", title: "<img src=x onerror=alert(1)> cc @octocat", detail: "<script>" })],
    });
    const out = renderDigest(evil).markdown;
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("@octocat");
  });

  it("renders triaged verdicts", () => {
    const t = renderDigest(
      makeVerdict({ triaged: true, triageReason: "docs-only change (1 file)", tier: makeTier({ level: 0 }) }),
    );
    expect(t.headline).toBe("Verdict: PASS (tier 0, triaged)");
    expect(t.text).toContain("Triaged: docs-only change (1 file)");
  });

  it("limits findings per severity with a note", () => {
    const many = Array.from({ length: 12 }, (_, n) => makeFinding({ id: `n${n}`, severity: "nit", title: `nit ${n}` }));
    const out = renderDigest(makeVerdict({ findings: many }), { maxFindingsPerSeverity: 5 });
    expect(out.markdown).toContain("…and 7 more nits not shown");
    expect(out.markdown).toContain("7 findings not shown");
  });

  it("stays under the size limit", () => {
    const huge = Array.from({ length: 400 }, (_, n) =>
      makeFinding({
        id: `h${n}`,
        severity: "blocker",
        title: `t${n}`,
        detail: "x".repeat(5000),
        evidence: ["y".repeat(600)],
      }),
    );
    const out = renderDigest(makeVerdict({ decision: "block", findings: huge }));
    expect(out.markdown.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(out.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(out.markdown).toContain("not shown");
  });
});

describe("renderBudgetBlockedDigest", () => {
  it("says what was hit and what to raise", () => {
    const d = renderBudgetBlockedDigest({
      tier: tier3,
      ceiling: "perChangeUsd",
      reason: "estimate exceeds $25",
      estimateUsd: 31.5,
    });
    expect(d.headline).toBe("Verdict: BLOCKED BY BUDGET (tier 3)");
    expect(d.markdown).toContain("`budget.perChangeUsd`");
    expect(d.markdown).toContain("$31.50");
    expect(d.text).toContain("raise budget.perChangeUsd");
  });
});

describe("renderPendingDigest", () => {
  it("renders with and without a tier", () => {
    expect(renderPendingDigest().headline).toBe("Verdict: PENDING");
    const d = renderPendingDigest(tier3);
    expect(d.headline).toBe("Verdict: PENDING (tier 3)");
    expect(d.markdown).toContain("Why tier 3");
  });
});
