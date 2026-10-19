import { describe, expect, it } from "vitest";
import { fakeGenAI } from "../test/fake-client.js";
import { API_KEY, apiError, apiKeyConn } from "../test/helpers.js";
import { retryDelayFromMessage } from "./errors.js";
import { baseModelId, guessTier, isAgenticModel, toModelInfo } from "./models.js";
import { geminiProvider } from "./provider.js";
import { thinkingConfigFor } from "./transport.js";

const p = (models: () => Promise<Array<{ name: string; supportedActions?: string[]; inputTokenLimit?: number }>>) =>
  geminiProvider({ clientFactory: () => fakeGenAI({ models }) });

describe("geminiProvider", () => {
  it("declares id and kinds", () => {
    expect(geminiProvider().id).toBe("gemini");
    expect(geminiProvider().connectionKinds).toEqual(["api-key"]);
  });

  it("validate maps and filters models", async () => {
    const v = await p(async () => [
      { name: "models/gemini-2.5-pro", supportedActions: ["generateContent"], inputTokenLimit: 1_000_000 },
      { name: "models/gemini-2.5-flash-lite", supportedActions: ["generateContent"] },
      { name: "models/text-embedding-004", supportedActions: ["embedContent"] },
      { name: "models/gemini-embedding-001", supportedActions: ["embedContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedActions: ["generateContent"] },
    ]).validate(apiKeyConn());
    expect(v.ok).toBe(true);
    expect(v.models?.map((m) => [m.name, m.tier])).toEqual([
      ["gemini-2.5-flash-lite", "small"],
      ["gemini-2.5-pro", "frontier"],
    ]);
    expect(v.models?.[1]?.contextTokens).toBe(1_000_000);
    expect(v.models?.[1]?.pricing).toBeDefined();
  });

  it("validate: bad key is ok:false and never echoes it", async () => {
    const v = await p(() => Promise.reject(apiError(400, `API key not valid. ${API_KEY}`))).validate(apiKeyConn());
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/invalid API key/);
    expect(JSON.stringify(v)).not.toContain(API_KEY);
  });

  it("validate: network failure is unreachable", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const v = await p(() => Promise.reject(err)).validate(apiKeyConn());
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/unreachable.*ENOTFOUND/);
  });

  it("validate: unsupported kinds fail without throwing", async () => {
    const v = await geminiProvider().validate({ ...apiKeyConn(), kind: "cloud", secret: { kind: "cloud" } });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/not supported/);
  });

  it("models throws a safe error on failure", async () => {
    await expect(p(() => Promise.reject(apiError(403, `denied ${API_KEY}`))).models(apiKeyConn())).rejects.toThrow(
      /403/,
    );
    await expect(p(() => Promise.reject(apiError(403, `denied ${API_KEY}`))).models(apiKeyConn())).rejects.not.toThrow(
      API_KEY,
    );
  });
});

describe("gemini helpers", () => {
  it("tiers", () => {
    expect(guessTier("gemini-2.5-pro")).toBe("frontier");
    expect(guessTier("gemini-3-pro-preview")).toBe("frontier");
    expect(guessTier("gemini-3.1-pro")).toBe("frontier");
    expect(guessTier("gemini-2.5-flash")).toBe("mid");
    expect(guessTier("gemini-2.5-flash-lite")).toBe("small");
    expect(guessTier("something")).toBe("mid");
  });
  it("ids and filters", () => {
    expect(baseModelId("models/gemini-2.0-flash-001")).toBe("gemini-2.0-flash");
    expect(isAgenticModel({ name: "models/gemini-2.5-pro" })).toBe(true);
    expect(isAgenticModel({ name: "models/gemma-3-27b-it", supportedActions: ["generateContent"] })).toBe(false);
    expect(isAgenticModel({ name: "models/gemini-2.5-pro", supportedActions: ["countTokens"] })).toBe(false);
    expect(toModelInfo({ name: "models/gemini-9-ultra" }, apiKeyConn()).pricing).toBeUndefined();
  });
  it("retryDelay parsing", () => {
    expect(retryDelayFromMessage('"retryDelay": "17s"')).toBe(17_000);
    expect(retryDelayFromMessage("retryDelay: none")).toBeUndefined();
  });
  it("thinking config", () => {
    expect(thinkingConfigFor("gemini-3-pro-preview", "high")).toEqual({ thinkingLevel: "HIGH" });
    expect(thinkingConfigFor("gemini-2.5-pro", "minimal")).toEqual({ thinkingBudget: 128 });
    expect(thinkingConfigFor("gemini-2.5-flash", "minimal")).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor("gemini-2.0-flash", "high")).toBeUndefined();
    expect(thinkingConfigFor("gemini-2.5-pro", undefined)).toBeUndefined();
  });
});
