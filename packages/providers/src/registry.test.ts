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
