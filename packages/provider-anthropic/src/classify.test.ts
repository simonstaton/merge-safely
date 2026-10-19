import { describe, expect, it } from "vitest";
import { classifyExit, RECOVERY_TURNS, RECOVERY_USD } from "./classify.js";

describe("classifyExit", () => {
  it("deadline wins", () => {
    expect(classifyExit({ timedOut: true, exitCode: null, deadlineMs: 500 })).toMatchObject({ status: "timeout" });
  });
  it("caller abort is an error", () => {
    expect(classifyExit({ aborted: true }).status).toBe("error");
  });
  it("max turns is a budget stop with recovery text, not a crash", () => {
    const c = classifyExit({ exitCode: 1, subtype: "error_max_turns", isError: true, maxTurns: 3 });
    expect(c.status).toBe("budget-exceeded");
    expect(c.error).toContain(RECOVERY_TURNS);
  });
  it("budget-looking subtypes and usd at cap are budget stops", () => {
    expect(classifyExit({ exitCode: 1, subtype: "error_max_budget_usd", isError: true }).status).toBe(
      "budget-exceeded",
    );
    const c = classifyExit({ exitCode: 1, isError: true, usd: 5.01, maxUsd: 5 });
    expect(c.status).toBe("budget-exceeded");
    expect(c.error).toContain(RECOVERY_USD);
    expect(classifyExit({ budgetHit: "usd", usd: 1, maxUsd: 1 }).status).toBe("budget-exceeded");
  });
  it("other non-zero exits are errors carrying the detail", () => {
    const c = classifyExit({ exitCode: 2, detail: "boom" });
    expect(c).toEqual({ status: "error", error: "exit code 2: boom" });
    expect(classifyExit({ exitCode: 1, isError: true, subtype: "error_during_execution" }).error).toContain(
      "error_during_execution",
    );
  });
  it("a clean exit is ok", () => {
    expect(classifyExit({ exitCode: 0, subtype: "success" })).toEqual({ status: "ok" });
  });
});
