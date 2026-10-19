import { describe, expect, it } from "vitest";
import { model } from "../test/helpers.js";
import { guessTier, localModels, priceFor, toModelInfo } from "./models.js";

describe("models", () => {
  it("guesses tier from the id", () => {
    expect(guessTier("claude-opus-9")).toBe("frontier");
    expect(guessTier("claude-fable-9")).toBe("frontier");
    expect(guessTier("claude-sonnet-9")).toBe("mid");
    expect(guessTier("claude-haiku-9")).toBe("small");
    expect(guessTier("some-gateway-model")).toBe("mid");
  });

  it("maps runtime models through the registry, preferring API capability fields", () => {
    const m = toModelInfo({ id: "claude-sonnet-5-5", display_name: "Sonnet", max_input_tokens: 500_000 }, "runtime");
    expect(m).toMatchObject({ name: "claude-sonnet-5-5", tier: "mid", supportsTools: true, contextTokens: 500_000 });
    expect(m.pricing?.inPerMTok).toBe(2);
    expect(m.effortLevels?.length).toBeGreaterThan(0);
    expect(toModelInfo({ id: "claude-haiku-4-5-20251001" }, "runtime").pricing?.inPerMTok).toBe(1);
    const unknown = toModelInfo({ id: "mystery" }, "runtime");
    expect(unknown.pricing).toBeUndefined();
    expect(unknown.contextTokens).toBeGreaterThan(0);
  });

  it("marks subscription models as plan-included", () => {
    const all = localModels({ planIncluded: true });
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((m) => m.zeroCost === true && m.provider === "anthropic")).toBe(true);
    expect(localModels({ planIncluded: false }).some((m) => m.zeroCost)).toBe(false);
  });

  it("prices known, zero-cost and unknown models (pessimistic, estimated)", () => {
    const usage = { in: 1_000_000, out: 100_000, cachedIn: 1_000_000, cacheWrite: 1_000_000 };
    expect(priceFor(model(), usage)).toEqual({ usd: 2 + 1 + 0.2 + 2.5, estimated: false });
    expect(priceFor(model({ zeroCost: true }), usage)).toEqual({ usd: 0, estimated: false });
    const unknown = priceFor(model({ pricing: undefined }), { in: 1_000_000, out: 0 });
    expect(unknown.estimated).toBe(true);
    expect(unknown.usd).toBeGreaterThanOrEqual(10); // at least the most expensive known input rate
  });
});
