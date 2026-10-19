import { createProviderRegistry, parseConnectionsInput } from "@merge-safely/providers";
import { describe, expect, it } from "vitest";
import { allProviders, compatibleProviders } from "./all.js";

const NOW = () => new Date("2026-10-19T00:00:00.000Z");

const INPUT = {
  "anthropic-key": { provider: "anthropic", apiKey: "sk-ant-test-0123456789abcdef" },
  "anthropic-proxy": {
    provider: "anthropic",
    baseUrl: "https://proxy.example/anthropic",
    apiKey: "proxy-key-0123456789",
  },
  "anthropic-gw": {
    provider: "anthropic-compatible",
    baseUrl: "https://gw.example/anthropic",
    apiKey: "gw-key-0123456789",
  },
  "openai-key": { provider: "openai", apiKey: "sk-test-0123456789abcdef" },
  openrouter: { provider: "openrouter", apiKey: "sk-or-0123456789", baseUrl: "https://openrouter.ai/api/v1" },
  groq: { provider: "groq", apiKey: "gsk_0123456789abcdef" },
  ollama: { provider: "ollama" },
  lmstudio: { provider: "lmstudio" },
  gemini: { provider: "gemini", apiKey: "AIza-test-0123456789" },
};

/** Which registered adapter serves each connection id. */
const EXPECTED: Record<keyof typeof INPUT, { kind: string; provider: string }> = {
  "anthropic-key": { kind: "api-key", provider: "anthropic" },
  "anthropic-proxy": { kind: "anthropic-compatible", provider: "anthropic" },
  "anthropic-gw": { kind: "anthropic-compatible", provider: "anthropic-compatible" },
  "openai-key": { kind: "api-key", provider: "openai" },
  openrouter: { kind: "openai-compatible", provider: "openai-compatible" },
  groq: { kind: "openai-compatible", provider: "openai-compatible" },
  ollama: { kind: "openai-compatible", provider: "ollama" },
  lmstudio: { kind: "openai-compatible", provider: "openai-compatible" },
  gemini: { kind: "api-key", provider: "gemini" },
};

describe("allProviders + ProviderRegistry", () => {
  const { connections, errors } = parseConnectionsInput(INPUT, {}, { now: NOW });
  const registry = createProviderRegistry(allProviders());

  it("parses every sample connection", () => {
    expect(errors).toEqual([]);
    expect(connections.map((c) => c.id).sort()).toEqual(Object.keys(INPUT).sort());
  });

  it.each(Object.keys(EXPECTED) as (keyof typeof INPUT)[])("resolves a provider for %s", (id) => {
    const c = connections.find((x) => x.id === id);
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.kind).toBe(EXPECTED[id].kind);
    const p = registry.forConnection(c);
    expect(p.id).toBe(EXPECTED[id].provider);
    expect(p.connectionKinds).toContain(c.kind);
  });

  it("gateway defaults are filled by the providers package (groq has no baseUrl in the input)", () => {
    const groq = connections.find((c) => c.id === "groq");
    expect(groq?.secret).toMatchObject({ kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" });
    expect(groq?.label).toBe("groq");
  });

  it("a connection naming provider lmstudio directly resolves to the lmstudio preset", () => {
    const p = registry.forConnection({
      id: "lms",
      provider: "lmstudio",
      kind: "openai-compatible",
      createdAt: NOW().toISOString(),
    });
    expect(p.id).toBe("lmstudio");
  });

  it("registers each provider id exactly once", () => {
    const ids = allProviders().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "openai-compatible",
      "anthropic-compatible",
      "ollama",
      "lmstudio",
    ]);
    expect(compatibleProviders().map((p) => p.id)).toEqual([
      "openai-compatible",
      "anthropic-compatible",
      "ollama",
      "lmstudio",
    ]);
  });
});
