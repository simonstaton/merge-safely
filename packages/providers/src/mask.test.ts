import { describe, expect, it } from "vitest";
import { scrubText, secretValues, urlCredentials } from "./mask.js";

describe("urlCredentials / secretValues", () => {
  it("treats userinfo and credential-named query values as secrets, but not configuration", () => {
    const url = "https://svc:pass-in-url-123@gw.example/v1?api-version=2024-10-21&api-key=k3y-value-9876&sig=abcdef123";
    const found = urlCredentials(url);
    expect(found).toEqual(expect.arrayContaining(["svc", "pass-in-url-123", "k3y-value-9876", "abcdef123"]));
    expect(found).not.toContain("2024-10-21");
    expect(urlCredentials("https://gw.example/?token=y%2Fz-encoded")).toEqual(
      expect.arrayContaining(["y/z-encoded", "y%2Fz-encoded"]),
    );
    const values = secretValues({ kind: "openai-compatible", baseUrl: url, apiKey: "gw-key-123456789" });
    expect(values).not.toContain("2024-10-21");
    expect(values).toContain("gw-key-123456789");
  });
});

describe("scrubText", () => {
  it("masks known values, then redacts other credential shapes", () => {
    const out = scrubText("bad key gw-key-123456789 (Authorization: Basic dXNlcjpwYXNzd29yZA==)", ["gw-key-123456789"]);
    expect(out).toBe("bad key …6789 (Authorization: [REDACTED])");
  });
});
