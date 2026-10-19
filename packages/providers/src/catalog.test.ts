import type { Connection, ConnectionKind, ModelInfo, ModelProvider } from "@merge-safely/core";
import { describe, expect, it, vi } from "vitest";
import { buildCatalog, catalogLookup } from "./catalog.js";
import { createProviderRegistry } from "./registry.js";

const model = (provider: string, name: string): ModelInfo => ({
  provider,
  name,
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 200_000,
  maxOutputTokens: 32_000,
  tier: "frontier",
});

function provider(id: string, kinds: ConnectionKind[], overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    connectionKinds: kinds,
    validate: async () => ({ ok: true }),
    models: async () => [model(id, `${id}-model`)],
    createRunner: () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

const KEY = "sk-very-secret-key-0001";
const conn = (id: string, p: string, kind: ConnectionKind = "api-key"): Connection => ({
  id,
  provider: p,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: KEY },
});

describe("buildCatalog", () => {
  it("collects models per connection", async () => {
    const reg = createProviderRegistry([provider("anthropic", ["api-key"]), provider("openai", ["api-key"])]);
    const cat = await buildCatalog(reg, [conn("a", "anthropic"), conn("o", "openai")]);
    expect([...cat.byConnection.keys()]).toEqual(["a", "o"]);
    expect(cat.byConnection.get("a")?.[0]?.name).toBe("anthropic-model");
    expect(cat.problems).toEqual([]);
    const lookup = catalogLookup(cat);
    expect(lookup("o")).toHaveLength(1);
    expect(lookup("missing")).toEqual([]);
  });

  it("records problems for unknown providers, wrong kinds and throwing providers without failing the rest", async () => {
    const reg = createProviderRegistry([
      provider("anthropic", ["api-key"]),
      provider("openai", ["api-key"], {
        models: async () => {
          throw new Error(`401 Unauthorized for key ${KEY}`);
        },
      }),
    ]);
    const cat = await buildCatalog(reg, [
      conn("a", "anthropic"),
      conn("o", "openai"),
      conn("g", "gemini"),
      conn("k", "anthropic", "oauth"),
    ]);
    expect(cat.byConnection.get("a")).toHaveLength(1);
    expect(cat.byConnection.get("o")).toEqual([]);
    expect(cat.problems.map((p) => p.connectionId)).toEqual(["o", "g", "k"]);
    expect(cat.problems[0]?.message).toContain("401");
    expect(cat.problems[0]?.message).not.toContain(KEY);
    expect(cat.problems[0]?.message).toContain("…0001");
    expect(cat.problems[1]?.message).toContain('no provider registered for "gemini"');
  });

  it("validates when asked and skips models for failed validations", async () => {
    const models = vi.fn(async () => [model("openai", "gpt-x")]);
    const reg = createProviderRegistry([
      provider("openai", ["api-key"], { validate: async () => ({ ok: false, message: `bad key ${KEY}` }), models }),
      provider("anthropic", ["api-key"], {
        validate: async () => {
          throw new Error("network down");
        },
      }),
    ]);
    const cat = await buildCatalog(reg, [conn("o", "openai"), conn("a", "anthropic")], { validate: true });
    expect(models).not.toHaveBeenCalled();
    expect(cat.byConnection.get("o")).toEqual([]);
    expect(cat.problems).toHaveLength(2);
    expect(cat.problems[0]?.message).toMatch(/^validation failed: bad key/);
    expect(cat.problems[0]?.message).not.toContain(KEY);
    expect(cat.problems[1]?.message).toBe("network down");
  });

  it("uses and fills the cache", async () => {
    const models = vi.fn(async () => [model("openai", "gpt-x")]);
    const reg = createProviderRegistry([provider("openai", ["api-key"], { models })]);
    const cache = new Map<string, ModelInfo[]>();
    await buildCatalog(reg, [conn("o", "openai")], { cache });
    expect(cache.get("o")?.[0]?.name).toBe("gpt-x");
    const cat = await buildCatalog(reg, [conn("o", "openai")], { cache });
    expect(models).toHaveBeenCalledTimes(1);
    expect(cat.byConnection.get("o")?.[0]?.name).toBe("gpt-x");
  });
});

describe("secretValues / URL credentials", () => {
  it("masks userinfo and query values from baseUrl in problems", async () => {
    const { secretValues } = await import("./mask.js");
    const secret = {
      kind: "openai-compatible" as const,
      baseUrl: "https://gwuser:hunter2password@gw.test/v1?api-key=query-secret-1&x=y%2Fz-encoded",
    };
    const values = secretValues(secret);
    expect(values).toEqual(expect.arrayContaining(["gwuser", "hunter2password", "query-secret-1"]));
    // `x` is not a credential-looking query key, so its value is configuration, not a secret.
    expect(values).not.toContain("y/z-encoded");
    const reg = createProviderRegistry([
      provider("openai-compatible", ["openai-compatible"], {
        models: async () => {
          throw new Error(`GET ${secret.baseUrl} failed; key query-secret-1`);
        },
      }),
    ]);
    const cat = await buildCatalog(reg, [
      { id: "gw", provider: "openai-compatible", kind: "openai-compatible", createdAt: "x", secret },
    ]);
    const msg = cat.problems[0]?.message ?? "";
    expect(msg).not.toContain("hunter2password");
    expect(msg).not.toContain("query-secret-1");
    expect(msg).toContain("gw.test");
  });
});
