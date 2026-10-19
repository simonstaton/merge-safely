import { describe, expect, it } from "vitest";
import { CliError, errorCode, formatError, SecretSet } from "../src/errors.js";

describe("error formatting", () => {
  it("is one line with the code and masks known secrets and secret shapes", () => {
    const s = new SecretSet();
    s.add("my-very-secret-value-1234");
    const err = Object.assign(
      new Error("first line\n  - second my-very-secret-value-1234\nghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      {
        code: "BUDGET_BLOCKED",
      },
    );
    const line = formatError(err, s);
    expect(line).not.toContain("\n");
    expect(line.startsWith("error [BUDGET_BLOCKED]: first line; second")).toBe(true);
    expect(line).not.toContain("my-very-secret-value-1234");
    expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("derives codes", () => {
    expect(errorCode(new CliError("X_Y", "m"))).toBe("X_Y");
    expect(errorCode(new Error("m"))).toBe("ERROR");
    class SeatingError extends Error {
      override name = "SeatingError";
    }
    expect(errorCode(new SeatingError("m"))).toBe("SEATING_ERROR");
    expect(errorCode("str")).toBe("ERROR");
  });
});
