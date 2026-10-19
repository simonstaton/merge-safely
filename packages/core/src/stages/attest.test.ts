import { describe, expect, it } from "vitest";
import { attest, countsTowardQuorum } from "./attest.js";
import { makeAudit, makeJudgeRun, makePolicy, makeRun } from "./test-helpers.js";

const policy = makePolicy();

describe("attest", () => {
  it("keeps a pass with enough observed work", () => {
    const run = makeRun();
    expect(attest(run, policy)).toBe(run);
  });

  it("rejects a pass with too few substantive calls, keeping the output", () => {
    const run = makeRun({ audit: makeAudit({ substantiveCalls: 2 }) });
    const out = attest(run, policy);
    expect(out.status).toBe("insufficient-work");
    expect(out.output).toEqual(run.output);
    expect(out.error).toContain("2 substantive tool calls (minimum 3)");
    expect(run.status).toBe("ok");
  });

  it("rejects a pass with no files read when required", () => {
    const run = makeRun({ audit: makeAudit({ filesRead: [] }) });
    expect(attest(run, policy).status).toBe("insufficient-work");
    expect(attest(run, makePolicy({ proofOfWork: { requireFilesRead: false } })).status).toBe("ok");
  });

  it("never discards a block for lack of work", () => {
    const run = makeRun({ output: { verdict: "block" }, audit: makeAudit({ substantiveCalls: 0, filesRead: [] }) });
    expect(attest(run, policy).status).toBe("ok");
  });

  it("attests judges: one that did not look has its votes ignored", () => {
    const lazy = makeJudgeRun({ audit: makeAudit({ substantiveCalls: 0, filesRead: [] }) });
    const out = attest(lazy, policy);
    expect(out.status).toBe("insufficient-work");
    expect(out.error).toContain("judge votes ignored");
    const diligent = makeJudgeRun();
    expect(attest(diligent, policy)).toBe(diligent);
  });

  it("leaves failed runs alone", () => {
    const failed = makeRun({ status: "timeout", output: null });
    expect(attest(failed, policy)).toBe(failed);
  });

  it("is idempotent", () => {
    const once = attest(makeRun({ audit: makeAudit({ substantiveCalls: 0 }) }), policy);
    expect(attest(once, policy)).toBe(once);
  });
});

describe("countsTowardQuorum", () => {
  it("counts only ok hunter runs with output", () => {
    expect(countsTowardQuorum(makeRun())).toBe(true);
    expect(countsTowardQuorum(makeRun({ output: { verdict: "block" } }))).toBe(true);
    expect(countsTowardQuorum(makeRun({ status: "insufficient-work" }))).toBe(false);
    expect(countsTowardQuorum(makeRun({ status: "schema-invalid", output: null }))).toBe(false);
    expect(countsTowardQuorum(makeJudgeRun())).toBe(false);
    expect(countsTowardQuorum(makeRun({ audit: makeAudit({ substantiveCalls: 0 }) }), policy)).toBe(false);
  });
});
