import { describe, expect, it } from "vitest";
import { apiKeyConn } from "../test/helpers.js";
import { baseModelId, guessTier, isChatModelId, toModelInfo } from "./models.js";

describe("models", () => {
  it("guesses tiers by id", () => {
    expect(guessTier("gpt-5")).toBe("frontier");
    expect(guessTier("gpt-5.1")).toBe("frontier");
    expect(guessTier("o3")).toBe("frontier");
    expect(guessTier("o4-mini-high")).toBe("frontier");
    expect(guessTier("gpt-5-mini")).toBe("mid");
    expect(guessTier("gpt-4.1")).toBe("mid");
    expect(guessTier("o4-mini")).toBe("mid");
    expect(guessTier("gpt-5-nano")).toBe("small");
    expect(guessTier("gpt-4.1-mini")).toBe("small");
    expect(guessTier("llama3.1:70b")).toBe("mid");
    expect(guessTier("openai/gpt-5-2025-08-07")).toBe("frontier");
  });

  it("normalises ids", () => {
    expect(baseModelId("openai/GPT-5-mini-2025-08-07")).toBe("gpt-5-mini");
  });

  it("filters non-chat ids", () => {
    expect(isChatModelId("gpt-4o")).toBe(true);
    expect(isChatModelId("o3")).toBe(true);
    expect(isChatModelId("gpt-4o-realtime-preview")).toBe(false);
    expect(isChatModelId("text-embedding-3-large")).toBe(false);
    expect(isChatModelId("dall-e-3")).toBe(false);
  });

  it("prices from the registry, with pessimistic fallback for unknown ids", () => {
    expect(toModelInfo("gpt-5-2025-08-07", apiKeyConn()).pricing?.inPerMTok).toBe(1.25);
    const pro = toModelInfo("gpt-5-pro", apiKeyConn());
    expect(pro.source).toMatch(/pessimistic/);
    expect(pro.pricing?.inPerMTok).toBeGreaterThanOrEqual(5);
    const unknown = toModelInfo("mystery", apiKeyConn());
    expect(unknown).toMatchObject({ tier: "mid", supportsTools: true, contextTokens: 128_000 });
    expect(unknown.source).toMatch(/pessimistic/);
  });

  it("never prices gpt-4o-2024-05-13 below its own rate", () => {
    const m = toModelInfo("gpt-4o-2024-05-13", apiKeyConn());
    expect(m.pricing?.inPerMTok).toBeGreaterThanOrEqual(5);
    expect(m.pricing?.outPerMTok).toBeGreaterThanOrEqual(15);
  });
});
