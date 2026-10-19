import { describe, expect, it } from "vitest";
import type { Finding } from "../types.js";
import { aggregate, rankFindings, requiredPasses } from "./aggregate.js";
import { assignFingerprints } from "./fingerprint.js";
import { makeAudit, makeFinding, makeJudgeRun, makePolicy, makeRun, makeTier } from "./test-helpers.js";

const policy = makePolicy();
const blockerDraft = makeFinding({ severity: "blocker", title: "Drops writes", class: "logic-error" });
const [BLOCKER] = assignFingerprints([blockerDraft]) as [Finding];
const pass = (seatId: string) => makeRun({ seatId });
const block = (seatId: string, findings = [blockerDraft]) =>
  makeRun({ seatId, output: { verdict: "block", findings: findings.map((f) => ({ ...f, id: "model-id" })) } });

const base = { tier: makeTier({ level: 2 }), judgeRuns: [makeJudgeRun()], policy };
const judged = (surviving: Finding[], judgesCounted = 1) => ({ judge: { surviving, judgesCounted } });

describe("requiredPasses", () => {
  it("maps tiers to policy quorum", () => {
    expect([0, 1, 2, 3].map((l) => requiredPasses(l as 0 | 1 | 2 | 3, policy))).toEqual([1, 1, 2, 2]);
  });
});

describe("aggregate", () => {
  it("passes when enough attested passes and no surviving blockers", () => {
    const r = aggregate({ ...base, hunterRuns: [pass("h1"), pass("h2")], ...judged([]) });
    expect(r.decision).toBe("pass");
    expect(r.quorum).toEqual({ required: 2, passed: 2, blocked: 0, invalid: 0 });
  });

  it("blocks on any surviving blocker regardless of quorum", () => {
    const r = aggregate({ ...base, hunterRuns: [pass("h1"), pass("h2"), pass("h3")], ...judged([BLOCKER]) });
    expect(r.decision).toBe("block");
    expect(r.reasons.some((x) => x.startsWith("blocker [logic-error] Drops writes"))).toBe(true);
  });

  it("counts a block only when one of its findings survived at important or above", () => {
    const upheld = aggregate({
      ...base,
      hunterRuns: [pass("h1"), block("h2")],
      ...judged([{ ...BLOCKER, severity: "important" }]),
    });
    expect(upheld.decision).toBe("block");
    expect(upheld.quorum).toMatchObject({ passed: 1, blocked: 1, invalid: 0 });

    const refuted = aggregate({ ...base, hunterRuns: [pass("h1"), pass("h3"), block("h2")], ...judged([]) });
    expect(refuted.decision).toBe("pass");
    expect(refuted.quorum).toMatchObject({ passed: 2, blocked: 0, invalid: 1 });

    const downgraded = aggregate({
      ...base,
      hunterRuns: [pass("h1"), block("h2")],
      ...judged([{ ...BLOCKER, severity: "nit" }]),
    });
    expect(downgraded.quorum.blocked).toBe(0);
    expect(downgraded.decision).toBe("pending");
  });

  it("ignores model-supplied finding ids when matching blocks", () => {
    // block() rewrites every id to "model-id"; matching still works through recomputed fingerprints.
    const r = aggregate({ ...base, hunterRuns: [block("h1")], ...judged([{ ...BLOCKER, severity: "important" }]) });
    expect(r.quorum.blocked).toBe(1);
  });

  it("is pending when passes are short, naming the missing count and failed seats", () => {
    const r = aggregate({
      ...base,
      hunterRuns: [
        pass("h1"),
        makeRun({ seatId: "h2", status: "timeout", output: null }),
        makeRun({ seatId: "h3", audit: makeAudit({ substantiveCalls: 0 }) }),
      ],
      ...judged([]),
    });
    expect(r.decision).toBe("pending");
    expect(r.quorum).toEqual({ required: 2, passed: 1, blocked: 0, invalid: 2 });
    expect(r.reasons.at(-1)).toBe(
      "missing 1 valid pass (have 1 of 2 required); failed seats: h2 (timeout), h3 (insufficient-work)",
    );
  });

  it("notes unjudged findings", () => {
    const r = aggregate({
      ...base,
      judgeRuns: [makeJudgeRun({ status: "error", judgeOutput: null })],
      hunterRuns: [pass("h1"), pass("h2")],
      ...judged([makeFinding({ id: "n1", severity: "nit" })], 0),
    });
    expect(r.decision).toBe("pass");
    expect(r.reasons.some((x) => x.startsWith("unjudged: no judge seat counted (1 ran)"))).toBe(true);
  });

  describe("carried findings", () => {
    const [IMPORTANT, NIT] = assignFingerprints([
      makeFinding({ severity: "important", file: "src/b.ts", title: "Missing retry" }),
      makeFinding({ severity: "nit", file: "src/c.ts", title: "Naming" }),
    ]) as [Finding, Finding];

    it("a carried blocker blocks even when every hunter passes", () => {
      const r = aggregate({ ...base, hunterRuns: [pass("h1"), pass("h2")], ...judged([]), carried: [BLOCKER] });
      expect(r.decision).toBe("block");
      expect(r.findings.map((f) => f.id)).toEqual([BLOCKER.id]);
      expect(r.reasons.some((x) => x.startsWith("carried blocker from an earlier round"))).toBe(true);
    });

    it("a carried important finding blocks; a carried nit is kept but does not", () => {
      expect(
        aggregate({ ...base, hunterRuns: [pass("h1"), pass("h2")], ...judged([]), carried: [IMPORTANT] }).decision,
      ).toBe("block");
      const nit = aggregate({ ...base, hunterRuns: [pass("h1"), pass("h2")], ...judged([]), carried: [NIT] });
      expect(nit.decision).toBe("pass");
      expect(nit.findings.map((f) => f.id)).toEqual([NIT.id]);
    });

    it("prefers the fresh judged copy when a carried finding was re-raised", () => {
      const r = aggregate({
        ...base,
        hunterRuns: [pass("h1"), pass("h2")],
        ...judged([{ ...BLOCKER, severity: "nit" }]),
        carried: [BLOCKER],
      });
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.severity).toBe("nit");
      expect(r.decision).toBe("pass");
    });
  });

  it("uses quorum 1 at tier 0", () => {
    const r = aggregate({ ...base, tier: makeTier({ level: 0 }), hunterRuns: [pass("h1")], ...judged([]) });
    expect(r.decision).toBe("pass");
  });
});

describe("rankFindings", () => {
  it("sorts by severity, class, file, line", () => {
    const fs = [
      makeFinding({ id: "1", severity: "nit", class: "a" }),
      makeFinding({ id: "2", severity: "blocker", class: "z" }),
      makeFinding({ id: "3", severity: "blocker", class: "b", file: undefined }),
      makeFinding({ id: "4", severity: "blocker", class: "b", file: "a.ts", line: 9 }),
      makeFinding({ id: "5", severity: "blocker", class: "b", file: "a.ts", line: 2 }),
      makeFinding({ id: "6", severity: "pre-existing", class: "a" }),
      makeFinding({ id: "7", severity: "important", class: "a" }),
    ];
    expect(rankFindings(fs).map((f) => f.id)).toEqual(["5", "4", "3", "2", "7", "1", "6"]);
    expect(fs[0]?.id).toBe("1");
  });
});
