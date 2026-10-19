import { describe, expect, it } from "vitest";
import type { Finding, JudgeVote } from "../types.js";
import { assignFingerprints, fingerprintFinding } from "./fingerprint.js";
import { applyJudgeVotes } from "./judge.js";
import { makeFinding, makeJudgeRun, makePolicy } from "./test-helpers.js";

const policy = makePolicy();
const [A, B] = assignFingerprints([
  makeFinding({ title: "Off by one", severity: "blocker" }),
  makeFinding({ title: "Race on cache write", class: "race", file: "src/cache.ts", line: 40 }),
]) as [Finding, Finding];

const judge = (
  id: string,
  votes: Array<Omit<JudgeVote, "findingId"> & { findingId: string }>,
  newFindings?: Finding[],
) => makeJudgeRun({ seatId: id, judgeOutput: { votes, ...(newFindings ? { newFindings } : {}) } });

describe("applyJudgeVotes", () => {
  it("passes everything through when no judge counted", () => {
    const failed = makeJudgeRun({ status: "timeout", judgeOutput: null });
    const r = applyJudgeVotes([A, B], [failed], policy);
    expect(r.judgesCounted).toBe(0);
    expect(r.surviving).toEqual([A, B]);
    expect(r.refuted).toEqual([]);
  });

  it("keeps findings meeting the agreement threshold and refutes the rest", () => {
    const r = applyJudgeVotes(
      [A, B],
      [
        judge("j1", [
          { findingId: A.id, decision: "confirm" },
          { findingId: B.id, decision: "refute" },
        ]),
        judge("j2", [
          { findingId: A.id, decision: "confirm" },
          { findingId: B.id, decision: "confirm" },
        ]),
      ],
      policy,
    );
    expect(r.judgesCounted).toBe(2);
    expect(r.surviving.map((f) => f.id)).toEqual([A.id]); // B: 1/2 = 0.5 < 0.6
    expect(r.refuted.map((f) => f.id)).toEqual([B.id]);
    expect(r.surviving[0]?.votes?.map((v) => v.seatId)).toEqual(["j1", "j2"]);
  });

  it("treats a missing vote as not agreeing", () => {
    const r = applyJudgeVotes([A], [judge("j1", [{ findingId: A.id, decision: "confirm" }]), judge("j2", [])], policy);
    expect(r.surviving).toEqual([]);
  });

  it("applies the lowest downgrade severity and never raises severity", () => {
    const r = applyJudgeVotes(
      [A, B],
      [
        judge("j1", [
          { findingId: A.id, decision: "downgrade", severity: "important" },
          { findingId: B.id, decision: "downgrade", severity: "blocker" },
        ]),
        judge("j2", [
          { findingId: A.id, decision: "downgrade", severity: "nit" },
          { findingId: B.id, decision: "confirm" },
        ]),
      ],
      policy,
    );
    expect(r.surviving.find((f) => f.id === A.id)?.severity).toBe("nit");
    expect(r.surviving.find((f) => f.id === B.id)?.severity).toBe("important");
  });

  it("treats a downgrade without severity as one step down", () => {
    const r = applyJudgeVotes([A], [judge("j1", [{ findingId: A.id, decision: "downgrade" }])], policy);
    expect(r.surviving[0]?.severity).toBe("important");
  });

  it("uses only the last vote per judge per finding and ignores unknown ids", () => {
    const r = applyJudgeVotes(
      [A],
      [
        judge("j1", [
          { findingId: A.id, decision: "refute" },
          { findingId: A.id, decision: "confirm" },
          { findingId: "nope", decision: "confirm" },
        ]),
      ],
      policy,
    );
    expect(r.surviving).toHaveLength(1);
    expect(r.surviving[0]?.votes).toHaveLength(1);
  });

  it("drops dropClasses even without judges", () => {
    const [style] = assignFingerprints([makeFinding({ class: "Style", title: "Prefer const" })]) as [Finding];
    const r = applyJudgeVotes([A, style], [], policy);
    expect(r.surviving.map((f) => f.id)).toEqual([A.id]);
    expect(r.dropped.map((f) => f.id)).toEqual([style.id]);
  });

  it("only counts ok judge runs with output", () => {
    const r = applyJudgeVotes(
      [A],
      [
        judge("j1", [{ findingId: A.id, decision: "confirm" }]),
        makeJudgeRun({
          seatId: "j2",
          status: "error",
          judgeOutput: { votes: [{ findingId: A.id, decision: "refute" }] },
        }),
      ],
      policy,
    );
    expect(r.judgesCounted).toBe(1);
    expect(r.surviving).toHaveLength(1);
  });

  describe("judge-raised findings", () => {
    const fresh = makeFinding({
      title: "Unbatched backfill",
      class: "unbatched-backfill",
      file: "jobs/b.ts",
      line: 3,
      severity: "blocker",
    });
    const freshId = fingerprintFinding(fresh);

    it("needs two judges when more than one counted", () => {
      const one = applyJudgeVotes([], [judge("j1", [], [fresh]), judge("j2", [])], policy);
      expect(one.surviving).toEqual([]);
      expect(one.refuted.map((f) => f.id)).toEqual([freshId]);

      const two = applyJudgeVotes(
        [],
        [judge("j1", [], [fresh]), judge("j2", [], [{ ...fresh, severity: "important", line: 5 }])],
        policy,
      );
      expect(two.surviving).toHaveLength(1);
      expect(two.surviving[0]).toMatchObject({ id: freshId, severity: "important" });
      expect(two.surviving[0]?.votes?.map((v) => v.seatId)).toEqual(["j1", "j2"]);
    });

    it("lets the single judge raise one, capped at important", () => {
      const r = applyJudgeVotes([], [judge("j1", [], [fresh])], policy);
      expect(r.surviving[0]).toMatchObject({ id: freshId, severity: "important" });
      const nit = applyJudgeVotes([], [judge("j1", [], [{ ...fresh, severity: "nit" }])], policy);
      expect(nit.surviving[0]?.severity).toBe("nit");
    });

    it("counts a judge re-raising a candidate as its confirm vote", () => {
      const r = applyJudgeVotes(
        [A],
        [judge("j1", [], [{ ...A, id: "" }]), judge("j2", [{ findingId: A.id, decision: "confirm" }])],
        policy,
      );
      expect(r.surviving.map((f) => f.id)).toEqual([A.id]);
    });

    it("drops judge-raised findings in dropClasses", () => {
      const r = applyJudgeVotes([], [judge("j1", [], [makeFinding({ class: "formatting" })])], policy);
      expect(r.surviving).toEqual([]);
      expect(r.dropped).toHaveLength(1);
    });
  });
});
