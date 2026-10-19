import type { Connection, ConnectionKind, ModelInfo, ModelProvider } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { createProviderRegistry, ProviderRegistry } from "./registry.js";

function fakeProvider(
  id: string,
  kinds: ConnectionKind[],
  models: ModelInfo[] = [],
  overrides: Partial<ModelProvider> = {},
): ModelProvider {
  return {
    id,
    connectionKinds: kinds,
    validate: async () => ({ ok: true }),
    models: async () => models,
    createRunner: () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

const conn = (provider: string, kind: ConnectionKind): Connection => ({
  id: "c1",
  provider,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: "sk-secret-value-xyz" },
});

describe("ProviderRegistry", () => {
  it("registers, gets and lists providers", () => {
    const a = fakeProvider("anthropic", ["api-key"]);
    const o = fakeProvider("openai", ["api-key", "openai-compatible"]);
    const r = createProviderRegistry([a]).register(o);
    expect(r.get("anthropic")).toBe(a);
    expect(r.get("gemini")).toBeUndefined();
    expect(r.list()).toEqual([a, o]);
    expect(r.ids()).toEqual(["anthropic", "openai"]);
    expect(r.has("openai")).toBe(true);
  });

  it("forConnection returns the provider when the kind is accepted", () => {
    const o = fakeProvider("openai", ["api-key"]);
    expect(createProviderRegistry([o]).forConnection(conn("openai", "api-key"))).toBe(o);
  });

  it("forConnection names the missing provider and the registered ones", () => {
    const r = createProviderRegistry([fakeProvider("anthropic", ["api-key"]), fakeProvider("openai", ["api-key"])]);
    expect(() => r.forConnection(conn("gemini", "api-key"))).toThrow(
      'no provider registered for "gemini" (connection c1); registered: anthropic, openai',
    );
    expect(() => new ProviderRegistry().forConnection(conn("gemini", "api-key"))).toThrow(/registered: none/);
  });

  it("forConnection rejects an unsupported kind and never prints the secret", () => {
    const r = createProviderRegistry([fakeProvider("anthropic", ["api-key", "oauth"])]);
    try {
      r.forConnection(conn("anthropic", "openai-compatible"));
      expect.unreachable();
    } catch (err: unknown) {
      expect(String(err)).toContain('does not accept connection kind "openai-compatible"');
      expect(String(err)).toContain("accepts: api-key, oauth");
      expect(String(err)).not.toContain("sk-secret");
    }
  });

  it("re-registering an id replaces the adapter", () => {
    const a1 = fakeProvider("anthropic", ["api-key"]);
    const a2 = fakeProvider("anthropic", ["api-key"]);
    const r = createProviderRegistry([a1, a2]);
    expect(r.get("anthropic")).toBe(a2);
    expect(r.list()).toHaveLength(1);
  });
});

describe("ProviderRegistry kind fallback", () => {
  const c = (provider: string, kind: ConnectionKind): Connection => ({ ...conn(provider, kind), id: "gw" });

  it("falls back to the adapter registered under the compatible kind id", () => {
    const oc = fakeProvider("openai-compatible", ["openai-compatible"]);
    const ac = fakeProvider("anthropic-compatible", ["anthropic-compatible"]);
    const r = createProviderRegistry([oc, ac]);
    expect(r.forConnection(c("openrouter", "openai-compatible"))).toBe(oc);
    expect(r.forConnection(c("my-proxy", "anthropic-compatible"))).toBe(ac);
  });

  it("prefers a provider registered under conn.provider", () => {
    const oc = fakeProvider("openai-compatible", ["openai-compatible"]);
    const ollama = fakeProvider("ollama", ["openai-compatible"]);
    expect(createProviderRegistry([oc, ollama]).forConnection(c("ollama", "openai-compatible"))).toBe(ollama);
  });

  it("errors only when neither exists, and never falls back for other kinds", () => {
    const r = createProviderRegistry([fakeProvider("anthropic", ["api-key"])]);
    expect(() => r.forConnection(c("openrouter", "openai-compatible"))).toThrow(
      'no provider registered for "openrouter" or "openai-compatible" (connection gw); registered: anthropic',
    );
    const r2 = createProviderRegistry([fakeProvider("openai-compatible", ["openai-compatible", "api-key"])]);
    expect(() => r2.forConnection(c("groq", "api-key"))).toThrow('no provider registered for "groq" (connection gw)');
  });
});
