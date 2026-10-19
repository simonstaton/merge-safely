import { describe, expect, it } from "vitest";
import { fakeClient } from "../test/fake-client.js";
import { API_KEY, apiError, apiKeyConn, compatConn } from "../test/helpers.js";
import { clientConfig, KEYLESS_PLACEHOLDER, OPENAI_BASE_URL } from "./client.js";
import { openaiProvider, wireApiFor } from "./provider.js";

function netError(code: string): Error {
  const e = new Error("Connection error.");
  e.name = "APIConnectionError";
  (e as Error & { cause: unknown }).cause = Object.assign(new TypeError("fetch failed"), { cause: { code } });
  return e;
}

const withModels = (impl: () => Promise<{ data: Array<{ id: string }> }>) =>
  openaiProvider({ clientFactory: () => fakeClient({ models: impl }) });

describe("openaiProvider", () => {
  it("declares id and connection kinds", () => {
    const p = openaiProvider();
    expect(p.id).toBe("openai");
    expect(p.connectionKinds).toEqual(["api-key", "openai-compatible", "oauth"]);
  });

  it("validate: ok with filtered, mapped first-party models", async () => {
    const p = withModels(async () => ({
      data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }, { id: "gpt-4.1-nano" }, { id: "whisper-1" }],
    }));
    const v = await p.validate(apiKeyConn());
    expect(v.ok).toBe(true);
    expect(v.models?.map((m) => m.name)).toEqual(["gpt-4.1-nano", "gpt-5"]);
    expect(v.models?.find((m) => m.name === "gpt-5")).toMatchObject({
      tier: "frontier",
      supportsTools: true,
      source: "runtime",
    });
    expect(v.models?.find((m) => m.name === "gpt-5")?.pricing).toBeDefined();
    expect(typeof v.latencyMs).toBe("number");
  });

  it("validate: 401 is an invalid key, never echoing it", async () => {
    const v = await withModels(() => Promise.reject(apiError(401, `Incorrect API key ${API_KEY}`))).validate(
      apiKeyConn(),
    );
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/invalid API key/);
    expect(JSON.stringify(v)).not.toContain(API_KEY);
  });

  it("validate: ENOTFOUND / ECONNREFUSED are unreachable", async () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
      const v = await withModels(() => Promise.reject(netError(code))).validate(compatConn());
      expect(v.ok).toBe(false);
      expect(v.message).toMatch(/unreachable at localhost:11434/);
      expect(v.message).toContain(code);
    }
  });

  it("validate: 404 on a compatible base URL assumes reachable", async () => {
    const v = await withModels(() => Promise.reject(apiError(404, "Not Found"))).validate(compatConn());
    expect(v).toMatchObject({ ok: true, message: "base URL does not expose /models, assuming reachable" });
    expect(v.models).toBeUndefined();
  });

  it("validate: 404 on api.openai.com is a failure", async () => {
    const v = await withModels(() => Promise.reject(apiError(404, "Not Found"))).validate(apiKeyConn());
    expect(v.ok).toBe(false);
  });

  it("validate never throws, even when the factory does", async () => {
    const p = openaiProvider({
      clientFactory: () => {
        throw new Error(`oops ${API_KEY}`);
      },
    });
    const v = await p.validate(apiKeyConn());
    expect(v.ok).toBe(false);
    expect(v.message).not.toContain(API_KEY);
  });

  it("validate rejects unsupported secret kinds without throwing", async () => {
    const v = await openaiProvider().validate({ ...apiKeyConn(), kind: "cloud", secret: { kind: "cloud" } });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/not supported/);
  });

  it("models: compatible endpoints keep every id and have no first-party pricing", async () => {
    const p = withModels(async () => ({ data: [{ id: "llama3.1:8b" }, { id: "openai/gpt-5" }] }));
    const models = await p.models(compatConn());
    expect(models.map((m) => m.name)).toEqual(["llama3.1:8b", "openai/gpt-5"]);
    expect(models.every((m) => m.pricing === undefined)).toBe(true);
    expect(models[0]?.provider).toBe("openai-compatible");
  });

  it("models: compatible list failure returns []", async () => {
    expect(await withModels(() => Promise.reject(apiError(404, "nope"))).models(compatConn())).toEqual([]);
  });

  it("models: first-party failure throws a safe error", async () => {
    await expect(withModels(() => Promise.reject(apiError(401, API_KEY))).models(apiKeyConn())).rejects.toThrow(/401/);
    await expect(withModels(() => Promise.reject(apiError(401, API_KEY))).models(apiKeyConn())).rejects.not.toThrow(
      API_KEY,
    );
  });
});

describe("wireApiFor / clientConfig", () => {
  it("chooses the wire API", () => {
    expect(wireApiFor(apiKeyConn())).toBe("responses");
    expect(wireApiFor(compatConn())).toBe("chat");
    expect(wireApiFor(compatConn({ options: { api: "responses" } }))).toBe("responses");
    expect(wireApiFor(apiKeyConn({ options: { api: "chat" } }))).toBe("chat");
    expect(wireApiFor(apiKeyConn({ options: { api: "bogus" } }))).toBe("responses");
  });

  it("maps secrets to SDK config", () => {
    expect(clientConfig(apiKeyConn())).toEqual({ apiKey: API_KEY, baseURL: OPENAI_BASE_URL });
    expect(
      clientConfig(
        compatConn({
          secret: { kind: "openai-compatible", baseUrl: "http://localhost:1234/v1/", headers: { "X-A": "b" } },
        }),
      ),
    ).toEqual({ apiKey: KEYLESS_PLACEHOLDER, baseURL: "http://localhost:1234/v1", defaultHeaders: { "X-A": "b" } });
    expect(
      clientConfig({ ...apiKeyConn(), kind: "oauth", secret: { kind: "oauth", accessToken: "tok-abc" } }).apiKey,
    ).toBe("tok-abc");
    expect(() => clientConfig({ ...apiKeyConn(), secret: { kind: "subscription" } })).toThrow(/not supported/);
  });
});
