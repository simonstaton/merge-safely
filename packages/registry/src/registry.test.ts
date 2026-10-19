import type { ModelInfo } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import {
  cheaperModel,
  describeModel,
  findModel,
  ladderFor,
  MODELS,
  modelsFor,
  pessimisticPricing,
  priceUsage,
  REGISTRY_VERSION,
  withPricing,
} from "./index.js";

describe("registry integrity", () => {
  it("has a version", () => {
    expect(REGISTRY_VERSION).toBe("2026-10");
  });

  it("has unique provider/name ids", () => {
    const ids = MODELS.map((m) => `${m.provider}/${m.name}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every model has a tier, limits and non-negative prices", () => {
    for (const m of MODELS) {
      expect(["frontier", "mid", "small"]).toContain(m.tier);
      expect(m.contextTokens).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
      expect(m.source).toBe(REGISTRY_VERSION);
      if (m.zeroCost) continue;
      expect(m.pricing, m.name).toBeDefined();
      for (const v of Object.values(m.pricing ?? {})) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("covers the required model ids", () => {
    for (const [p, n] of [
      ["anthropic", "claude-fable-5-1"],
      ["anthropic", "claude-opus-5-5"],
      ["anthropic", "claude-sonnet-5-5"],
      ["anthropic", "claude-haiku-5-5"],
      ["anthropic", "claude-opus-4-1"],
      ["anthropic", "claude-sonnet-4-5"],
      ["anthropic", "claude-haiku-4-5"],
      ["openai", "gpt-5"],
      ["openai", "gpt-5-mini"],
      ["openai", "gpt-5-nano"],
      ["openai", "gpt-5-codex"],
      ["openai", "gpt-4.1"],
      ["openai", "o3"],
      ["openai", "o4-mini"],
      ["gemini", "gemini-2.5-pro"],
      ["gemini", "gemini-2.5-flash"],
      ["gemini", "gemini-2.5-flash-lite"],
    ] as const) {
      expect(findModel(p, n)?.name, n).toBe(n);
    }
  });

  it("local models are zero cost", () => {
    const local = modelsFor("ollama");
    expect(local.length).toBeGreaterThan(0);
    for (const m of local) expect(m.zeroCost).toBe(true);
  });
});

describe("findModel", () => {
  it("matches date-suffixed ids by prefix", () => {
    expect(findModel("anthropic", "claude-sonnet-5-5-20260301")?.name).toBe("claude-sonnet-5-5");
    expect(findModel("openai", "gpt-5-2026-08-07")?.name).toBe("gpt-5");
    expect(findModel("openai", "gpt-5-mini-2025-08-07")?.name).toBe("gpt-5-mini");
    expect(findModel("anthropic", "claude-opus-4-5@20251101")?.name).toBe("claude-opus-4-5");
  });

  it("does not let a shorter id swallow a sibling model", () => {
    expect(findModel("openai", "gpt-5-mini")?.name).toBe("gpt-5-mini");
    expect(findModel("openai", "gpt-5-turbo")).toBeUndefined();
    expect(findModel("anthropic", "claude-opus-5-5")?.name).toBe("claude-opus-5-5");
    expect(findModel("anthropic", "claude-opus-5-9")).toBeUndefined();
  });

  it("strips gateway decorations", () => {
    expect(findModel("gemini", "models/gemini-2.5-pro")?.name).toBe("gemini-2.5-pro");
    expect(findModel("bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0")?.name).toBe("claude-opus-4-1");
    expect(findModel("bedrock", "anthropic.claude-opus-5-5")?.provider).toBe("bedrock");
    expect(findModel("openai-compatible", "anthropic/claude-sonnet-5-5")?.name).toBe("claude-sonnet-5-5");
    expect(findModel("ollama", "qwen2.5-coder:32b")?.name).toBe("qwen2.5-coder");
  });

  it("is provider-scoped", () => {
    expect(findModel("openai", "claude-opus-5-5")).toBeUndefined();
    expect(findModel("anthropic", "nope")).toBeUndefined();
  });
});

describe("pricing", () => {
  const pricing = { inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.2, cacheWritePerMTok: 2.5 };

  it("prices input, output, cache read and cache write separately", () => {
    const r = priceUsage(pricing, { in: 1_000_000, out: 100_000, cachedIn: 2_000_000, cacheWrite: 400_000 });
    expect(r.estimated).toBe(false);
    expect(r.usd).toBeCloseTo(2 + 1 + 0.4 + 1, 10);
  });

  it("falls back to input rate for cache reads and 1.25x input for cache writes", () => {
    const r = priceUsage(
      { inPerMTok: 4, outPerMTok: 0 },
      { in: 0, out: 0, cachedIn: 1_000_000, cacheWrite: 1_000_000 },
    );
    expect(r.usd).toBeCloseTo(4 + 5, 10);
  });

  it("prices unknown pricing pessimistically and flags it", () => {
    const usage = { in: 1_000_000, out: 1_000_000 };
    const r = priceUsage(undefined, usage);
    expect(r.estimated).toBe(true);
    for (const m of MODELS) {
      if (m.pricing) expect(r.usd).toBeGreaterThanOrEqual(priceUsage(m.pricing, usage).usd);
    }
  });

  it("zero-cost models price at zero", () => {
    const local = findModel("ollama", "llama3.3") as ModelInfo;
    expect(priceUsage(local, { in: 9e9, out: 9e9 })).toEqual({ usd: 0, estimated: false });
  });

  it("ignores negative or missing token counts", () => {
    expect(priceUsage(pricing, { in: -5, out: 0 }).usd).toBe(0);
  });

  it("pessimistic fallback is >= every known rate", () => {
    const p = pessimisticPricing();
    for (const m of MODELS) {
      if (!m.pricing || m.zeroCost) continue;
      expect(p.inPerMTok).toBeGreaterThanOrEqual(m.pricing.inPerMTok);
      expect(p.outPerMTok).toBeGreaterThanOrEqual(m.pricing.outPerMTok);
      expect(p.cachedInPerMTok ?? 0).toBeGreaterThanOrEqual(m.pricing.cachedInPerMTok ?? 0);
      expect(p.cacheWritePerMTok ?? 0).toBeGreaterThanOrEqual(m.pricing.cacheWritePerMTok ?? 0);
    }
  });

  it("withPricing fills unknown pricing and stamps source", () => {
    const unknown: ModelInfo = {
      provider: "openai-compatible",
      name: "mystery",
      supportsTools: true,
      supportsStructuredOutput: false,
      contextTokens: 8000,
      maxOutputTokens: 2000,
      tier: "mid",
    };
    const filled = withPricing(unknown);
    expect(filled.pricing).toEqual(pessimisticPricing());
    expect(filled.source).toBe(`${REGISTRY_VERSION}:pessimistic`);
    expect(withPricing({ ...unknown, provider: "ollama" }).zeroCost).toBe(true);
    const known = findModel("openai", "gpt-5") as ModelInfo;
    expect(withPricing(known).pricing).toEqual(known.pricing);
  });
});

describe("ladder", () => {
  it("steps frontier -> mid -> small within a provider", () => {
    const opus = findModel("anthropic", "claude-opus-5-5") as ModelInfo;
    const mid = cheaperModel("anthropic", opus);
    expect(mid?.name).toBe("claude-sonnet-5-5");
    const small = cheaperModel("anthropic", mid as ModelInfo);
    expect(small?.name).toBe("claude-haiku-5-5");
    expect(cheaperModel("anthropic", small as ModelInfo)).toBeUndefined();
  });

  it("stays inside the provider", () => {
    const gpt5 = findModel("openai", "gpt-5") as ModelInfo;
    expect(cheaperModel("openai", gpt5)?.provider).toBe("openai");
    expect(ladderFor("gemini").map((m) => m.tier)).toEqual(["frontier", "mid", "small"]);
  });

  it("skips a missing tier", () => {
    const catalog = MODELS.filter((m) => m.provider === "anthropic" && m.tier !== "mid");
    const opus = findModel("anthropic", "claude-opus-5-5") as ModelInfo;
    expect(cheaperModel("anthropic", opus, catalog)?.tier).toBe("small");
  });
});

describe("describeModel", () => {
  it("is short and includes tier and price", () => {
    expect(describeModel(findModel("anthropic", "claude-sonnet-5-5") as ModelInfo)).toBe(
      "Claude Sonnet 5.5 (mid, $2/$10 per MTok)",
    );
    expect(describeModel(findModel("ollama", "llama3.3") as ModelInfo)).toContain("zero cost");
  });
});
