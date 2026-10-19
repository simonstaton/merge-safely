import { describe, expect, it } from "vitest";
import { conn } from "../test/helpers.js";
import { envSecretValues, REDACTED, scrub, scrubDeep, secretValues } from "./secrets.js";

describe("scrub", () => {
  it("removes connection secrets and credential shapes", () => {
    const c = conn({
      secret: { kind: "oauth", accessToken: "tok-very-secret-123456", refreshToken: "ref-very-secret-987654" },
    });
    const out = scrub(
      [
        "failed with tok-very-secret-123456 and ref-very-secret-987654",
        "Bearer abcdefghijklmnop",
        "sk-ant-api03-zzzzzzzzzzzz sk-proj-abcdefghijklmnopqrst",
        "x-api-key: qqqqqqqqqqqq",
        "ghp_0123456789abcdefghijABCDEFGHIJ gho_0123456789abcdefghijABCD github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
        "AKIAABCDEFGHIJKLMNOP",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        "https://user:hunter2pw@gateway.example/v1",
      ].join("\n"),
      secretValues(c),
    );
    for (const leak of [
      "tok-very",
      "ref-very",
      "abcdefghijklmnop",
      "zzzz",
      "sk-proj",
      "qqqq",
      "ghp_",
      "gho_",
      "github_pat_",
      "AKIA",
      "MIIE",
      "hunter2pw",
    ]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain(REDACTED);
    expect(out).toContain("gateway.example");
  });

  it("collects credentials embedded in a gateway base URL", () => {
    const c = conn({
      kind: "anthropic-compatible",
      secret: {
        kind: "anthropic-compatible",
        baseUrl: "https://svc:pass-in-url-123@gw.example",
        apiKey: "gw-key-123456789",
      },
    });
    expect(secretValues(c)).toEqual(expect.arrayContaining(["gw-key-123456789", "pass-in-url-123"]));
  });

  it("finds credential-looking env values", () => {
    expect(
      envSecretValues({
        GITHUB_TOKEN: "abcdefgh1234",
        AWS_SECRET_ACCESS_KEY: "zzzzzzzz9999",
        PATH: "/usr/bin:/bin",
        HOME: "/home/someone",
      }),
    ).toEqual(["abcdefgh1234", "zzzzzzzz9999"]);
  });

  it("deep-scrubs every string in a value", () => {
    const v = {
      summary: "key sk-ant-api03-aaaaaaaaaaaa",
      findings: [{ title: "x", evidence: ["ghp_0123456789abcdefghijABCDEFGHIJ"], line: 3 }],
    };
    const out = scrubDeep(v);
    expect(JSON.stringify(out)).not.toMatch(/sk-ant|ghp_/);
    expect(out.findings[0]?.line).toBe(3);
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("rate limited (429) at src/sk-learn.ts")).toBe("rate limited (429) at src/sk-learn.ts");
  });
});
