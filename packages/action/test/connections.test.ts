import { SecretSet } from "@merge-safely/cli";
import { describe, expect, it, vi } from "vitest";
import { parseConnections, rawSecretStrings } from "../src/connections.js";

const KEY = "sk-ant-api03-supersecretvalue1234";
const OPENAI = "sk-proj-anothersecretvalue5678";

function parse(text: string, env: NodeJS.ProcessEnv = {}) {
  const masked: string[] = [];
  const secrets = new SecretSet();
  try {
    return { connections: parseConnections(text, env, (s) => masked.push(s), secrets), masked, error: undefined };
  } catch (err: unknown) {
    return { connections: [], masked, error: err instanceof Error ? err.message : String(err) };
  }
}

describe("parseConnections", () => {
  it("parses the documented YAML map and masks every key", () => {
    const r = parse(
      `anthropic-main: { provider: anthropic, apiKey: "${KEY}" }\nopenai-main:    { provider: openai,    apiKey: "${OPENAI}" }\n`,
    );
    expect(r.error).toBeUndefined();
    expect(r.connections.map((c) => [c.id, c.provider, c.kind])).toEqual([
      ["anthropic-main", "anthropic", "api-key"],
      ["openai-main", "openai", "api-key"],
    ]);
    expect(r.masked).toEqual(expect.arrayContaining([KEY, OPENAI]));
  });

  it("reads apiKeyEnv from the environment and masks the resolved value", () => {
    const r = parse("anthropic-main: { provider: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }", {
      ANTHROPIC_API_KEY: KEY,
    });
    expect(r.error).toBeUndefined();
    expect(r.masked).toContain(KEY);
  });

  it("masks header values and gateway keys", () => {
    const r = parse(
      'gw: { provider: openrouter, baseUrl: "https://gw.example/v1", apiKey: "gwsecret-123456789", headers: { X-Team: "team-header-secret-1" } }',
    );
    expect(r.masked).toEqual(expect.arrayContaining(["gwsecret-123456789", "team-header-secret-1"]));
  });

  it("requires the input", () => {
    expect(parse("  ").error).toMatch(/^connections input is required/);
  });

  it("reports invalid YAML by line only, never quoting the text", () => {
    const r = parse(`anthropic-main: { provider: anthropic, apiKey: ${KEY}: oops }`);
    expect(r.error).toMatch(/connections input is not valid YAML at line 1/);
    expect(r.error).not.toContain(KEY);
  });

  it("never lets the YAML library print the source (unresolved tag), and fails by line only", () => {
    const warn = vi.spyOn(process, "emitWarning");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const r = parse(`anthropic-main: { provider: anthropic, apiKey: !foo "${KEY}" }`);
      expect(r.error).toMatch(/^connections input is not valid YAML at line 1\./);
      expect(r.error).not.toContain(KEY);
      expect(warn).not.toHaveBeenCalled();
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).not.toContain(KEY);
    } finally {
      warn.mockRestore();
      stderr.mockRestore();
    }
  });

  it("rejects duplicate keys by line", () => {
    expect(parse("a: { provider: anthropic, apiKey: x }\na: { provider: openai, apiKey: y }").error).toMatch(
      /not valid YAML at line 2/,
    );
  });

  it("rejects a non-map", () => {
    expect(parse("- a\n- b").error).toMatch(/must be a YAML map/);
  });

  it("names each bad connection and the fix for an empty secret", () => {
    const r = parse('anthropic-main: { provider: anthropic, apiKey: "" }');
    expect(r.error).toMatch(/connections input is invalid/);
    expect(r.error).toMatch(/anthropic-main/);
    expect(r.error).toMatch(/Settings > Secrets and variables > Actions/);
  });

  it("explains a missing apiKeyEnv variable", () => {
    const r = parse("anthropic-main: { provider: anthropic, apiKeyEnv: NOPE_KEY }");
    expect(r.error).toMatch(/NOPE_KEY/);
  });

  it("never echoes a secret in validation errors", () => {
    const r = parse(`bad: { provider: anthropic, apiKey: "${KEY}", nonsense: true }`);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain(KEY);
  });
});

describe("rawSecretStrings", () => {
  it("collects secret-named keys and header values", () => {
    expect(
      rawSecretStrings({
        a: { apiKey: "k", accessToken: "t", headers: { Foo: "h" }, provider: "anthropic", model: "m" },
      }),
    ).toEqual(["k", "t", "h"]);
  });
});
