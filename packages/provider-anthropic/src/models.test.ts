import { describe, expect, it } from "vitest";
import { guessTier, localModels, lookupKnownModel, priceUsage, toModelInfo } from "./models.js";

describe("models", () => {
  it("guesses tier from the id", () => {
    expect(guessTier("claude-opus-5-5")).toBe("frontier");
    expect(guessTier("claude-fable-5-1")).toBe("frontier");
    expect(guessTier("claude-sonnet-5-5")).toBe("mid");
    expect(guessTier("claude-haiku-4-5-20251001")).toBe("small");
    expect(guessTier("some-gateway-model")).toBe("mid");
  });

  it("matches dated snapshots to the longest known id", () => {
    expect(lookupKnownModel("claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5");
    expect(lookupKnownModel("claude-opus-5-5")?.id).toBe("claude-opus-5-5");
    expect(lookupKnownModel("claude-opus-5")?.id).toBe("claude-opus-5");
    expect(lookupKnownModel("claude-unknown-9")).toBeUndefined();
  });

  it("maps runtime models, preferring API capability fields", () => {
    const m = toModelInfo({ id: "claude-sonnet-5-5", display_name: "Sonnet", max_input_tokens: 500_000 }, "runtime");
    expect(m).toMatchObject({ name: "claude-sonnet-5-5", tier: "mid", supportsTools: true, contextTokens: 500_000 });
    expect(m.maxOutputTokens).toBe(128_000);
    expect(m.pricing?.inPerMTok).toBe(2);
    const unknown = toModelInfo({ id: "mystery" }, "runtime");
    expect(unknown.pricing).toBeUndefined();
    expect(unknown.contextTokens).toBeGreaterThan(0);
  });

  it("marks subscription models as plan-included", () => {
    const all = localModels({ planIncluded: true });
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((m) => m.zeroCost === true)).toBe(true);
    expect(localModels({ planIncluded: false }).some((m) => m.zeroCost)).toBe(false);
  });

  it("prices usage including cache reads and writes", () => {
    const usd = priceUsage(
      { inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.2, cacheWritePerMTok: 2.5 },
      { in: 1_000_000, out: 100_000, cachedIn: 1_000_000, cacheWrite: 1_000_000 },
    );
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 2.5, 6);
    expect(priceUsage({ inPerMTok: 10, outPerMTok: 0 }, { in: 0, out: 0, cachedIn: 1_000_000 })).toBeCloseTo(1, 6);
    expect(priceUsage(undefined, { in: 5, out: 5 })).toBeUndefined();
  });
});
