import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY, apiKeyConn } from "../test/helpers.js";
import { defaultClientFactory } from "./client.js";

describe("defaultClientFactory ignores the ambient environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ignores GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_GENAI_USE_VERTEXAI", async () => {
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key-should-not-be-used");
    vi.stubEnv("GOOGLE_API_KEY", "env-google-key-should-not-be-used");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/creds.json");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: { headers?: ConstructorParameters<typeof Headers>[0] }) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const res = await defaultClientFactory(apiKeyConn()).models.generateContent({
      model: "gemini-2.5-pro",
      contents: "x",
    });
    expect(res.candidates?.[0]?.finishReason).toBe("STOP");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("rejects an empty key instead of falling back to env keys", () => {
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key-should-not-be-used");
    expect(() => defaultClientFactory(apiKeyConn({ secret: { kind: "api-key", apiKey: "" } }))).toThrow(/empty/);
  });
});
