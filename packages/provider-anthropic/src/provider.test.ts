import Anthropic from "@anthropic-ai/sdk";
import type { Connection } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { fakeClaude } from "../test/fake-claude.js";
import { API_KEY, conn, FakeClient, model } from "../test/helpers.js";
import { ClaudeCodeRunner } from "./cli-runner.js";
import { createAnthropicClient } from "./client.js";
import { MessagesRunner } from "./messages-runner.js";
import { anthropicProvider } from "./provider.js";

const sub = (over: Partial<Connection> = {}) =>
  conn({ kind: "subscription", secret: { kind: "subscription" }, ...over });

describe("anthropicProvider", () => {
  it("declares its id and connection kinds", () => {
    const p = anthropicProvider();
    expect(p.id).toBe("anthropic");
    expect(p.connectionKinds).toEqual(["api-key", "oauth", "anthropic-compatible", "subscription"]);
  });

  it("validates a key and returns reachable models", async () => {
    const client = new FakeClient(
      [],
      [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-haiku-4-5-20251001" }],
    );
    const p = anthropicProvider({ clientFactory: () => client });
    const v = await p.validate(conn());
    expect(v.ok).toBe(true);
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
    expect(v.models?.map((m) => [m.name, m.tier])).toEqual([
      ["claude-opus-5-5", "frontier"],
      ["claude-haiku-4-5-20251001", "small"],
    ]);
    expect(v.models?.[1]?.contextTokens).toBe(200_000);
    expect(v.models?.[0]?.source).toBe("runtime");
  });

  it("never throws on a bad key or an unreachable endpoint", async () => {
    const auth = new Anthropic.AuthenticationError(
      401,
      { error: { message: `bad ${API_KEY}` } },
      `bad ${API_KEY}`,
      new Headers(),
    );
    const v401 = await anthropicProvider({ clientFactory: () => new FakeClient([], auth) }).validate(conn());
    expect(v401).toMatchObject({ ok: false, message: "invalid key" });
    expect(JSON.stringify(v401)).not.toContain(API_KEY);

    const net = new Anthropic.APIConnectionError({ message: "getaddrinfo ENOTFOUND" });
    const vNet = await anthropicProvider({ clientFactory: () => new FakeClient([], net) }).validate(conn());
    expect(vNet).toMatchObject({ ok: false, message: "unreachable" });

    const vCloud = await anthropicProvider().validate(conn({ kind: "cloud", secret: { kind: "cloud" } }));
    expect(vCloud.ok).toBe(false);
  });

  it("validates through the real SDK with an injected fetch, using the gateway base URL", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      const headers = new Headers(init?.headers);
      seen.push(headers.get("x-api-key") === "gw-key-1234567890" ? "key-ok" : "key-missing");
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-sonnet-5-5", type: "model", display_name: "S", created_at: "" }],
          has_more: false,
          first_id: null,
          last_id: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const c = conn({
      kind: "anthropic-compatible",
      secret: {
        kind: "anthropic-compatible",
        baseUrl: "https://gateway.example/anthropic",
        apiKey: "gw-key-1234567890",
      },
    });
    const v = await anthropicProvider({ fetch: fakeFetch }).validate(c);
    expect(v.ok).toBe(true);
    expect(seen[0]).toMatch(/^https:\/\/gateway\.example\/anthropic\/v1\/models/);
    expect(seen[1]).toBe("key-ok");
  });

  it("maps a 401 from the real SDK to 'invalid key'", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const v = await anthropicProvider({ fetch: fakeFetch }).validate(conn());
    expect(v).toMatchObject({ ok: false, message: "invalid key" });
  });

  it("sends oauth tokens as a bearer with the oauth beta header", async () => {
    let auth: string | null = null;
    let beta: string | null = null;
    let apiKey: string | null = "unset";
    const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      auth = h.get("authorization");
      beta = h.get("anthropic-beta");
      apiKey = h.get("x-api-key");
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createAnthropicClient(
      conn({ kind: "oauth", secret: { kind: "oauth", accessToken: "oauth-access-123456" } }),
      fakeFetch,
    );
    await client.models.list();
    expect(auth).toBe("Bearer oauth-access-123456");
    expect(beta).toContain("oauth-2025-04-20");
    expect(apiKey).toBeNull();
  });

  it("validates a subscription by checking the claude CLI", async () => {
    const fake = fakeClaude({ version: "2.1.303" });
    const ok = await anthropicProvider({ cli: { binary: fake.binary } }).validate(sub());
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("2.1.303");
    expect(ok.models?.every((m) => m.zeroCost)).toBe(true);
    const missing = await anthropicProvider({ cli: { binary: "/nonexistent/claude" } }).validate(sub());
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("not found");
  });

  it("lists models, falling back to the local table", async () => {
    const p = anthropicProvider({ clientFactory: () => new FakeClient([], [{ id: "claude-sonnet-5-5" }]) });
    expect((await p.models(conn())).map((m) => m.name)).toEqual(["claude-sonnet-5-5"]);
    const failing = anthropicProvider({ clientFactory: () => new FakeClient([], new Error("down")) });
    expect((await failing.models(conn())).length).toBeGreaterThan(5);
    const subs = await anthropicProvider().models(sub());
    expect(subs.every((m) => m.zeroCost === true)).toBe(true);
  });

  it("chooses the runner by connection kind and options", () => {
    const p = anthropicProvider({ clientFactory: () => new FakeClient([]) });
    expect(p.createRunner(conn(), model())).toBeInstanceOf(MessagesRunner);
    expect(p.createRunner(conn({ options: { runner: "cli" } }), model())).toBeInstanceOf(ClaudeCodeRunner);
    expect(p.createRunner(sub(), model())).toBeInstanceOf(ClaudeCodeRunner);
  });
});
