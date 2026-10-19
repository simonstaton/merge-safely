import type { Connection, ModelInfo } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import type { Catalog } from "./catalog.js";
import { maskSecret } from "./mask.js";
import { describeConnection, redactConnection, resolveModelRef } from "./resolve.js";

const model = (name: string, effortLevels?: string[]): ModelInfo => ({
  provider: "anthropic",
  name,
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 1,
  maxOutputTokens: 1,
  tier: "mid",
  ...(effortLevels ? { effortLevels } : {}),
});

const anthropic: Connection = {
  id: "anthropic-main",
  provider: "anthropic",
  kind: "api-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  defaultModel: "claude-sonnet-5-5",
  options: { runner: "cli" },
  secret: { kind: "api-key", apiKey: "sk-ant-api03-abcdefghijk3Fd" },
};
const local: Connection = {
  id: "local",
  provider: "ollama",
  kind: "openai-compatible",
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
};

const catalog: Catalog = {
  byConnection: new Map([
    ["anthropic-main", [model("claude-sonnet-5-5", ["low", "high"]), model("claude-opus-5-5")]],
    ["local", []],
  ]),
  problems: [],
};

describe("resolveModelRef", () => {
  it("resolves a known model", () => {
    expect(resolveModelRef({ connection: "anthropic-main", model: "claude-opus-5-5" }, [anthropic], catalog)).toEqual({
      connectionId: "anthropic-main",
      provider: "anthropic",
      name: "claude-opus-5-5",
    });
  });

  it("keeps effort, matches case-insensitively and warns on unknown effort", () => {
    const warnings: string[] = [];
    const ref = resolveModelRef(
      { connection: "anthropic-main", model: "Claude-Sonnet-5-5", effort: "max" },
      [anthropic],
      catalog,
      { onWarning: (w) => warnings.push(w) },
    );
    expect(ref).toEqual({
      connectionId: "anthropic-main",
      provider: "anthropic",
      name: "claude-sonnet-5-5",
      effort: "max",
    });
    expect(warnings[0]).toContain('does not list effort "max"');
  });

  it("throws with a fix hint for an unknown connection", () => {
    expect(() => resolveModelRef({ connection: "openai-main", model: "gpt-5" }, [anthropic, local], catalog)).toThrow(
      /connection "openai-main", which does not exist\. Known connections: anthropic-main, local\. Fix: .*merge-safely connect/,
    );
  });

  it("throws listing available models for an unknown model", () => {
    expect(() => resolveModelRef({ connection: "anthropic-main", model: "gpt-5" }, [anthropic], catalog)).toThrow(
      /model "gpt-5" is not available on connection anthropic-main \(anthropic\)\. Available: claude-sonnet-5-5, claude-opus-5-5/,
    );
  });

  it("allows any model name when the catalog is empty, with a warning", () => {
    const warnings: string[] = [];
    const lookup = (id: string) => catalog.byConnection.get(id) ?? [];
    const ref = resolveModelRef({ connection: "local", model: "qwen3-coder" }, [local], lookup, {
      onWarning: (w) => warnings.push(w),
    });
    expect(ref.name).toBe("qwen3-coder");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no known models");
  });
});

describe("redactConnection / describeConnection / maskSecret", () => {
  it("strips the secret", () => {
    const r = redactConnection(anthropic);
    expect("secret" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-ant");
    expect(r).toMatchObject({
      id: "anthropic-main",
      provider: "anthropic",
      kind: "api-key",
      options: { runner: "cli" },
    });
  });

  it("describes with a masked tail", () => {
    expect(describeConnection(anthropic)).toBe(
      "anthropic-main (anthropic, api-key, key …k3Fd, default claude-sonnet-5-5)",
    );
    expect(describeConnection(local)).toBe("local (ollama, openai-compatible, localhost:11434, no key)");
    expect(describeConnection(redactConnection(anthropic))).toBe(
      "anthropic-main (anthropic, api-key, default claude-sonnet-5-5)",
    );
    expect(
      describeConnection({
        ...anthropic,
        kind: "oauth",
        secret: { kind: "oauth", accessToken: "oauth-token-abcdefWXYZ" },
      }),
    ).toContain("token …WXYZ");
  });

  it("masks short secrets entirely", () => {
    expect(maskSecret("abc")).toBe("****");
    expect(maskSecret("sk-1234567")).toBe("****");
    expect(maskSecret("sk-ant-abcdefk3Fd")).toBe("…k3Fd");
  });
});

describe("resolveModelRef with discovery problems", () => {
  it("names the discovery failure in the warning", () => {
    const warnings: string[] = [];
    resolveModelRef(
      { connection: "local", model: "qwen3-coder" },
      [local],
      { byConnection: new Map([["local", []]]), problems: [{ connectionId: "local", message: "ECONNREFUSED" }] },
      { onWarning: (w) => warnings.push(w) },
    );
    expect(warnings[0]).toContain("model discovery failed (ECONNREFUSED)");
  });
});
