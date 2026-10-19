import type { Connection } from "@merge-safely/core";
import type { AnthropicLike } from "@merge-safely/provider-anthropic";
import { describe, expect, it } from "vitest";
import { conn, input, model, PASS, seat, ws } from "../test/helpers.js";
import { anthropicCompatibleProvider } from "./anthropic-compatible.js";

const GW_KEY = "gw-key-1234567890abcdef";
const proxy = (): Connection =>
  conn({
    provider: "anthropic-compatible",
    secret: {
      kind: "anthropic-compatible",
      baseUrl: "https://gateway.example/anthropic",
      apiKey: GW_KEY,
      headers: { "x-gateway-team": "platform" },
    },
  });

interface Seen {
  url: string;
  key: string | null;
  team: string | null;
}

/** A fetch standing in for the gateway: records where each request went and answers like the Messages API. */
function gatewayFetch(seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), key: headers.get("x-api-key"), team: headers.get("x-gateway-team") });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).includes("/v1/models")) {
      return json({
        data: [{ id: "claude-sonnet-5-5", type: "model", display_name: "Sonnet", created_at: "" }],
        has_more: false,
        first_id: null,
        last_id: null,
      });
    }
    return json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "tool_use", id: "toolu_1", name: "submit_review", input: PASS }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }) as typeof fetch;
}

describe("anthropicCompatibleProvider", () => {
  it("registers under its own id and kind only", () => {
    const p = anthropicCompatibleProvider();
    expect(p.id).toBe("anthropic-compatible");
    expect(p.connectionKinds).toEqual(["anthropic-compatible"]);
  });

  it("validate and the runner both call the base URL from the secret, with its key and headers", async () => {
    const seen: Seen[] = [];
    const p = anthropicCompatibleProvider({ fetch: gatewayFetch(seen) });
    const c = proxy();

    const v = await p.validate(c);
    expect(v.ok).toBe(true);
    expect(v.models?.map((m) => [m.name, m.provider])).toEqual([["claude-sonnet-5-5", "anthropic-compatible"]]);

    const run = await p.createRunner(c, model()).run(seat(), input(), ws());
    expect(run.output?.verdict).toBe("pass");

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.url.startsWith("https://gateway.example/anthropic/v1/")).toBe(true);
      expect(s.key).toBe(GW_KEY);
      expect(s.team).toBe("platform");
    }
    expect(seen.some((s) => s.url.includes("/v1/messages"))).toBe(true);
  });

  it("hands the connection (with its base URL) to an injected client factory", async () => {
    const got: Connection[] = [];
    const client: AnthropicLike = {
      messages: { create: () => Promise.reject(new Error("unused")) },
      models: { list: async () => ({ data: [{ id: "claude-haiku-4-5" }] }) },
    };
    const p = anthropicCompatibleProvider({
      clientFactory: (c) => {
        got.push(c);
        return client;
      },
    });
    const models = await p.models(proxy());
    expect(models.map((m) => [m.name, m.provider])).toEqual([["claude-haiku-4-5", "anthropic-compatible"]]);
    expect(models[0]?.pricing).toBeDefined();
    expect(got[0]?.secret).toMatchObject({
      kind: "anthropic-compatible",
      baseUrl: "https://gateway.example/anthropic",
    });
  });

  it("refuses secrets of other kinds instead of falling through to api.anthropic.com", async () => {
    const p = anthropicCompatibleProvider();
    const apiKey = conn({ provider: "anthropic-compatible", secret: { kind: "api-key", apiKey: GW_KEY } });
    const v = await p.validate(apiKey);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/not supported/);
    expect(JSON.stringify(v)).not.toContain(GW_KEY);
    expect(() => p.createRunner(apiKey, model())).toThrow(/not supported/);
    await expect(p.models(apiKey)).rejects.toThrow(/not supported/);
  });
});
