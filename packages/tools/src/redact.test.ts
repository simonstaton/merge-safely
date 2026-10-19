import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REDACTED, redactDiagnostics, redactToolOutput } from "./redact.js";

// Fake credentials assembled at runtime so secret scanners never see a literal key in this repo.
const j = (...parts: string[]) => parts.join("");
const SK_ANT = j("sk-ant-", "api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1");
const SK_PROJ = j("sk-", "proj-", "Ab3dEf6hIj9kLm2nOp5qRs8tUv");
const GHP = j("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const GH_PAT = j("github_pat_", "11ABCDEFG0123456789_ab");
const AWS = j("AKIA", "IOSFODNN7", "EXAMPLE");
const BEARER = j("Zm9vYmFy", "MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A", "Q");
const PEM = j(
  "-----BEGIN ",
  "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END ",
  "RSA PRIVATE KEY-----",
);

const repoFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

describe("redactToolOutput (what reviewers read)", () => {
  it.each(["core/src/types.ts", "provider-anthropic/src/client.ts", "providers/src/schema.ts"])(
    "leaves this repo's credential-handling source %s byte-for-byte unchanged",
    (rel) => {
      const src = repoFile(rel);
      expect(redactToolOutput(src)).toBe(src);
    },
  );

  it.each([
    '{ kind: "api-key"; apiKey: string }',
    "{ apiKey: s.apiKey, authToken: null, baseURL }",
    "apiKey: string;",
    "const apiKey = opts.apiKey;",
    '"Use Bearer authentication"',
    "src/sk-learn-wrapper.ts",
    "headers.authorization = buildHeader(user)",
    "Authorization: does every route check the caller?",
    "`apiKey: null`",
    "const token = getToken();\nif (password === input) return skip;",
    "PASSWORD=example",
    "API_TOKEN=test",
    'password: "changeme"',
  ])("leaves code and prose alone: %s", (code) => {
    expect(redactToolOutput(code)).toBe(code);
  });

  it.each([
    ["anthropic key", `const key = "${SK_ANT}";`],
    ["openai key", `OPENAI_API_KEY=${SK_PROJ}`],
    ["github token", `GITHUB_TOKEN=${GHP}`],
    ["github fine-grained token", `token ${GH_PAT}`],
    ["aws key id", `aws_access_key_id = ${AWS}`],
    ["pem private key", PEM],
    ["bearer header", `Authorization: Bearer ${BEARER}`],
  ])("still redacts a real %s", (_kind, text) => {
    const out = redactToolOutput(text);
    expect(out).toContain(REDACTED);
    for (const secret of [SK_ANT, SK_PROJ, GHP, GH_PAT, AWS, BEARER, "MIIEowIBAAKCAQEA"])
      expect(out).not.toContain(secret);
  });

  it("removes known secret values verbatim before the shape rules", () => {
    expect(redactToolOutput("conn uses gw-key-plainletters here", ["gw-key-plainletters"])).toBe(
      `conn uses ${REDACTED} here`,
    );
  });
});

describe("redactDiagnostics (error text)", () => {
  it("redacts the Authorization credential even when the line continues with a parenthesis", () => {
    expect(redactDiagnostics(j("Authorization: Basic ", "dXNlcjpwYXNzd29yZA==", " (from netrc)"))).toBe(
      `Authorization: ${REDACTED} (from netrc)`,
    );
    expect(redactDiagnostics(j("authorization: token ", "abcdef0123456789xyz", " (expired)"))).toBe(
      `authorization: ${REDACTED} (expired)`,
    );
  });

  it("is stricter than tool output for the same text", () => {
    expect(redactDiagnostics("x-api-key: qqqqqqqqqqqq")).toBe(`x-api-key: ${REDACTED}`);
    expect(redactToolOutput("x-api-key: qqqqqqqqqqqq")).toBe("x-api-key: qqqqqqqqqqqq");
  });
});
