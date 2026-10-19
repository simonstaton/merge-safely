import { describe, expect, it } from "vitest";
import { conn } from "../test/helpers.js";
import { scrub, secretValues } from "./secrets.js";

describe("scrub", () => {
  it("removes connection secrets and credential shapes", () => {
    const c = conn({
      secret: { kind: "oauth", accessToken: "tok-very-secret-123456", refreshToken: "ref-very-secret-987654" },
    });
    const out = scrub(
      "failed with tok-very-secret-123456 and ref-very-secret-987654; Bearer abcdefghijklmnop; sk-ant-api03-zzzzzzzzzzzz; x-api-key: qqqqqqqqqqqq",
      secretValues(c),
    );
    expect(out).not.toContain("tok-very-secret");
    expect(out).not.toContain("ref-very-secret");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("sk-ant-api03-zzzz");
    expect(out).not.toContain("qqqqqqqqqqqq");
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("rate limited (429)")).toBe("rate limited (429)");
  });
});
