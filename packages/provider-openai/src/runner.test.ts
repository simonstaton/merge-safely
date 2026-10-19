import type { Connection } from "@merge-safely/core";
import { APIConnectionTimeoutError } from "openai";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import { chatCalls, chatText, fakeClient, rCall, responses, rMessage, rUsage } from "../test/fake-client.js";
import {
  API_KEY,
  apiError,
  apiKeyConn,
  BLOCK,
  compatConn,
  connError,
  fakeTools,
  hang,
  input,
  MODEL,
  PASS,
  seat,
  WS,
} from "../test/helpers.js";
import type { OpenAILike } from "./client.js";
import { openaiProvider } from "./provider.js";

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 2 };

function runner(
  client: OpenAILike,
  conn: Connection = apiKeyConn(),
  extra: Parameters<ReturnType<typeof openaiProvider>["createRunner"]>[2] = {},
) {
  const tools = fakeTools();
  const onUsage = vi.fn();
  const r = openaiProvider({ clientFactory: () => client, retry: FAST_RETRY }).createRunner(conn, MODEL, {
    tools: tools.factory,
    onUsage,
    ...extra,
  });
  return { r, tools, onUsage };
}

describe("responses transport", () => {
  it("executes a tool call, then accepts submit_review", async () => {
    const client = fakeClient({
      responses: [
        () => responses([rCall("read_file", { path: "src/a.ts" })], rUsage(1000, 100, 400)),
        () => responses([rCall("submit_review", PASS, "call_submit")], rUsage(2000, 50)),
      ],
    });
    const { r, tools, onUsage } = runner(client);
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("pass");
    expect(run.judgeOutput).toBeUndefined();
    expect(tools.calls).toEqual([{ id: "call_read_file", name: "read_file", input: { path: "src/a.ts" } }]);
    expect(run.audit.filesRead).toEqual(["src/a.ts"]);
    expect(run.audit.totalCalls).toBe(1);
    expect(run.audit.turns).toBe(2);
    expect(run.audit.tokens).toEqual({ in: 600 + 2000, out: 150, cachedIn: 400 });
    // 2600 in @ $1 + 400 cached @ $0.1 + 150 out @ $10 per MTok
    expect(run.audit.costUsd).toBeCloseTo(0.0026 + 0.00004 + 0.0015, 8);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ tokens: { in: 600, out: 100, cachedIn: 400 } });
    expect(run.headSha).toBe("abc123");

    const first = client.responseBodies[0];
    expect(first?.instructions).toBe("SYSTEM PROMPT");
    expect(first?.input).toEqual([{ role: "user", content: "USER PROMPT" }]);
    expect(first?.store).toBe(false);
    expect(first).not.toHaveProperty("temperature");
    const names = (first?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));
    expect(names).toEqual(["read_file", "submit_review"]);
    const second = client.responseBodies[1];
    expect(JSON.stringify(second?.input)).toContain('"type":"function_call_output"');
    expect(JSON.stringify(second?.input)).toContain("contents of src/a.ts");
  });

  it("passes reasoning effort and never temperature", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", PASS)])] });
    const { r } = runner(client);
    const run = await r.run(
      seat({ model: { connectionId: "c", provider: "openai", name: "gpt-5", effort: "high" } }),
      input(),
      WS,
    );
    expect(run.status).toBe("ok");
    expect(client.responseBodies[0]?.reasoning).toEqual({ effort: "high" });
    expect(client.responseBodies[0]?.include).toEqual(["reasoning.encrypted_content"]);
    expect(client.responseBodies[0]).not.toHaveProperty("temperature");
  });

  it("returns a block verdict with findings", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", BLOCK)])] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(run.output?.findings[0]).toMatchObject({ severity: "blocker", id: "" });
  });

  it("validates judge output by seat role", async () => {
    const votes = { votes: [{ findingId: "f1", decision: "confirm", reason: "reproduced" }] };
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", votes)])] });
    const run = await runner(client).r.run(seat({ role: "judge" }), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output).toBeNull();
    expect(run.judgeOutput?.votes[0]?.decision).toBe("confirm");
  });

  it("feeds schema errors back, then succeeds on retry", async () => {
    const client = fakeClient({
      responses: [
        () => responses([rCall("submit_review", { verdict: "maybe" })]),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    const fed = JSON.stringify(client.responseBodies[1]?.input);
    expect(fed).toContain("submission rejected");
    expect(fed).toContain("verdict");
  });

  it("is schema-invalid after three invalid submissions", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", "{not json")])] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("schema-invalid");
    expect(run.output).toBeNull();
    expect(run.audit.turns).toBe(3);
    expect(run.error).toMatch(/schema/);
  });

  it("salvages JSON from a plain-text final message", async () => {
    const client = fakeClient({
      responses: [() => responses([rMessage(`Here you go:\n\`\`\`json\n${JSON.stringify(PASS)}\n\`\`\``)])],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.summary).toBe("looks fine");
  });

  it("nudges after plain text without JSON", async () => {
    const client = fakeClient({
      responses: [() => responses([rMessage("I think it is fine.")]), () => responses([rCall("submit_review", PASS)])],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(JSON.stringify(client.responseBodies[1]?.input)).toContain("submit_review");
  });

  it("stops with budget-exceeded once maxUsd is crossed", async () => {
    const client = fakeClient({
      responses: [() => responses([rCall("read_file", { path: "a" })], rUsage(1_000_000, 0))],
    });
    const { r, tools } = runner(client);
    const run = await r.run(seat({ budget: { maxTurns: 50, deadlineMs: 10_000, maxUsd: 0.5 } }), input(), WS);
    expect(run.status).toBe("budget-exceeded");
    expect(run.error).toMatch(/Recovery: raise the per-seat budget/);
    expect(run.error).toMatch(/not a crash/);
    expect(run.audit.costUsd).toBeCloseTo(1, 6);
    expect(tools.calls).toHaveLength(0);
    expect(client.responseBodies).toHaveLength(1);
  });

  it("honours a valid submission in the response that crossed the cap", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", PASS)], rUsage(1_000_000, 0))] });
    const run = await runner(client).r.run(
      seat({ budget: { maxTurns: 5, deadlineMs: 10_000, maxUsd: 0.5 } }),
      input(),
      WS,
    );
    expect(run.status).toBe("ok");
  });

  it("stops with budget-exceeded at maxTurns", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("read_file", { path: "a" })])] });
    const run = await runner(client).r.run(seat({ budget: { maxTurns: 3, deadlineMs: 10_000 } }), input(), WS);
    expect(run.status).toBe("budget-exceeded");
    expect(run.audit.turns).toBe(3);
    expect(run.error).toMatch(/Turn limit of 3/);
  });

  it("prices an unpriced model pessimistically so maxUsd still enforces, and warns", async () => {
    const client = fakeClient({
      responses: [() => responses([rCall("read_file", { path: "a" })], rUsage(1_000_000, 0))],
    });
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const r = openaiProvider({ clientFactory: () => client }).createRunner(
      apiKeyConn(),
      { ...MODEL, pricing: undefined },
      { logger, tools: fakeTools().factory },
    );
    const run = await r.run(seat({ budget: { maxTurns: 5, deadlineMs: 10_000, maxUsd: 1 } }), input(), WS);
    expect(run.status).toBe("budget-exceeded");
    expect(run.audit.costUsd).toBeGreaterThan(1);
    expect(run.error).toMatch(/pessimistic/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("pessimistic fallback"))).toBe(true);
  });

  it("times out at the deadline", async () => {
    const client = fakeClient({ responses: [(_b, signal) => hang(signal)] });
    const run = await runner(client).r.run(seat({ budget: { maxTurns: 5, deadlineMs: 50 } }), input(), WS);
    expect(run.status).toBe("timeout");
    expect(run.output).toBeNull();
  });

  it("times out even when the client ignores the abort signal", async () => {
    const client = fakeClient({ responses: [() => new Promise<never>(() => undefined)] });
    const run = await runner(client).r.run(seat({ budget: { maxTurns: 5, deadlineMs: 50 } }), input(), WS);
    expect(run.status).toBe("timeout");
  });

  it("reports an external abort as an error", async () => {
    const client = fakeClient({ responses: [(_b, signal) => hang(signal)] });
    const ac = new AbortController();
    const p = runner(client).r.run(seat(), input(), WS, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const run = await p;
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/aborted/);
  });

  it("retries 429 honouring retry-after-ms, then succeeds", async () => {
    let attempts = 0;
    const client = fakeClient({
      responses: [
        () => {
          attempts++;
          throw apiError(429, "Rate limit reached", { "retry-after-ms": "5" });
        },
        () => {
          attempts++;
          throw apiError(503, "upstream overloaded");
        },
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(attempts).toBe(2);
    expect(run.audit.turns).toBe(1);
  });

  it("gives up after 3 retries with status error", async () => {
    const client = fakeClient({ responses: [() => Promise.reject(apiError(429, "Rate limit reached"))] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(client.responseBodies).toHaveLength(4);
    expect(run.error).toMatch(/rate limited/);
  });

  it("does not retry insufficient_quota", async () => {
    const client = fakeClient({ responses: [() => Promise.reject(apiError(429, "quota", {}, "insufficient_quota"))] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(client.responseBodies).toHaveLength(1);
  });

  it("falls back from strict to non-strict schemas on a 400 that mentions strict", async () => {
    const strictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary", "findings"],
      properties: {
        verdict: { type: "string", enum: ["pass", "block"] },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
      },
    };
    const client = fakeClient({
      responses: [
        () => Promise.reject(apiError(400, "Invalid schema for function 'submit_review': strict mode not supported")),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input({ outputSchema: strictSchema }), WS);
    expect(run.status).toBe("ok");
    const strictOf = (i: number) =>
      (client.responseBodies[i]?.tools ?? []).map((t) => (t.type === "function" ? t.strict : null));
    expect(strictOf(0)).toEqual([false, true]);
    expect(strictOf(1)).toEqual([false, false]);
  });

  it("does not retry other 400s and reports error", async () => {
    const client = fakeClient({ responses: [() => Promise.reject(apiError(400, "model not supported"))] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(client.responseBodies).toHaveLength(1);
  });

  it("returns unknown-tool errors to the model instead of throwing", async () => {
    const client = fakeClient({
      responses: [
        () => responses([rCall("write_file", { path: "x" })]),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const { r, tools } = runner(client);
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(tools.calls).toHaveLength(0);
    expect(JSON.stringify(client.responseBodies[1]?.input)).toContain("unknown tool");
  });
});

describe("responses replay and retries", () => {
  const reasoning = (id: string): ResponseOutputItem => ({
    type: "reasoning",
    id,
    summary: [],
    encrypted_content: `enc-${id}`,
  });

  it("replays output items verbatim (ids, reasoning, empty messages) then function_call_output", async () => {
    const fc: ResponseOutputItem = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"a"}',
    };
    const client = fakeClient({
      responses: [
        () => responses([reasoning("rs_1"), fc]),
        () => responses([reasoning("rs_2"), rMessage("")]),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    const second = client.responseBodies[1]?.input as unknown[];
    expect(second.slice(1)).toEqual([
      reasoning("rs_1"),
      fc,
      { type: "function_call_output", call_id: "call_1", output: "contents of a" },
    ]);
    const third = client.responseBodies[2]?.input as unknown[];
    // the empty message is replayed with its id so rs_2 keeps its following item; then the nudge
    expect(third.slice(4, 6)).toEqual([reasoning("rs_2"), rMessage("")]);
    expect(JSON.stringify(third[6])).toContain("submit_review");
  });

  it("drops a trailing reasoning item with nothing after it", async () => {
    const client = fakeClient({
      responses: [
        () => ({
          output: [reasoning("rs_1")],
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: rUsage(10, 10),
        }),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(JSON.stringify(client.responseBodies[1]?.input)).not.toContain("rs_1");
  });

  it("accepts the first valid submit_review among several in one turn", async () => {
    const client = fakeClient({
      responses: [
        () => responses([rCall("submit_review", { verdict: "nope" }, "c1"), rCall("submit_review", BLOCK, "c2")]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(client.responseBodies).toHaveLength(1);
  });

  it("retries real SDK connection errors: timeout, ECONNRESET, EAI_AGAIN, UND_ERR_SOCKET", async () => {
    const client = fakeClient({
      responses: [
        () => Promise.reject(new APIConnectionTimeoutError()),
        () => Promise.reject(connError("ECONNRESET")),
        () => Promise.reject(connError("EAI_AGAIN")),
        () => Promise.reject(connError("UND_ERR_SOCKET")),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await openaiProvider({
      clientFactory: () => client,
      retry: { baseDelayMs: 1, maxDelayMs: 2, maxRetries: 4 },
    })
      .createRunner(apiKeyConn(), MODEL, {})
      .run(seat(), input(), WS);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("ok");
    expect(client.responseBodies).toHaveLength(5);
  });

  it("retries 408/409/425 and 5xx statuses", async () => {
    const client = fakeClient({
      responses: [
        () => Promise.reject(apiError(425, "too early")),
        () => Promise.reject(apiError(409, "conflict")),
        () => Promise.reject(apiError(502, "bad gateway")),
        () => responses([rCall("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
  });

  it("stops with error when Retry-After is beyond the deadline instead of sleeping into a timeout", async () => {
    const client = fakeClient({
      responses: [() => Promise.reject(apiError(429, "Rate limit reached", { "retry-after": "60" }))],
    });
    const t0 = Date.now();
    const run = await runner(client).r.run(seat({ budget: { maxTurns: 5, deadlineMs: 5_000 } }), input(), WS);
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/rate limited beyond the seat deadline/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("does not resend non-strict for unrelated 400s that mention parameters", async () => {
    const strictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary", "findings"],
      properties: {
        verdict: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
      },
    };
    const client = fakeClient({
      responses: [() => Promise.reject(apiError(400, "Unsupported parameter: 'reasoning'"))],
    });
    const run = await runner(client).r.run(seat(), input({ outputSchema: strictSchema }), WS);
    expect(run.status).toBe("error");
    expect(client.responseBodies).toHaveLength(1);
  });
});

describe("chat transport", () => {
  it("defaults openai-compatible connections to chat completions and passes", async () => {
    const client = fakeClient({
      chat: [
        () => chatCalls([{ name: "read_file", args: { path: "b.ts" }, id: "t1" }]),
        () => chatCalls([{ name: "submit_review", args: BLOCK }]),
      ],
    });
    const { r, tools } = runner(client, compatConn());
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(tools.calls).toHaveLength(1);
    expect(client.responseBodies).toHaveLength(0);
    const first = client.chatBodies[0];
    expect(first?.messages.slice(0, 2)).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);
    // strict is omitted entirely, not sent as false
    expect(JSON.stringify(first?.tools)).not.toContain("strict");
    expect(client.chatBodies[1]?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "contents of b.ts",
    });
  });

  it("uses chat for api.openai.com when options.api is chat", async () => {
    const client = fakeClient({ chat: [() => chatCalls([{ name: "submit_review", args: PASS }])] });
    const run = await runner(client, apiKeyConn({ options: { api: "chat" } })).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(client.chatBodies).toHaveLength(1);
  });

  it("uses responses for compatible endpoints when options.api is responses", async () => {
    const client = fakeClient({ responses: [() => responses([rCall("submit_review", PASS)])] });
    const run = await runner(client, compatConn({ options: { api: "responses" } })).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(client.responseBodies).toHaveLength(1);
  });

  it("is schema-invalid after repeated invalid submissions", async () => {
    const client = fakeClient({ chat: [() => chatCalls([{ name: "submit_review", args: { verdict: "pass" } }])] });
    const run = await runner(client, compatConn()).r.run(seat(), input(), WS);
    expect(run.status).toBe("schema-invalid");
    expect(client.chatBodies).toHaveLength(3);
  });

  it("salvages JSON from text, records cached tokens", async () => {
    const client = fakeClient({
      chat: [
        () =>
          chatText(JSON.stringify(PASS), {
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 200 },
          } as never),
      ],
    });
    const run = await runner(client, compatConn()).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.audit.tokens).toEqual({ in: 300, out: 10, cachedIn: 200 });
  });

  it("budget-exceeded on chat", async () => {
    const client = fakeClient({
      chat: [
        () =>
          chatCalls([{ name: "read_file", args: { path: "a" } }], { prompt_tokens: 2_000_000, completion_tokens: 0 }),
      ],
    });
    const run = await runner(client, compatConn()).r.run(
      seat({ budget: { maxTurns: 50, deadlineMs: 10_000, maxUsd: 1 } }),
      input(),
      WS,
    );
    expect(run.status).toBe("budget-exceeded");
  });

  it("times out on chat", async () => {
    const client = fakeClient({ chat: [(_b, s) => hang(s)] });
    const run = await runner(client, compatConn()).r.run(
      seat({ budget: { maxTurns: 5, deadlineMs: 40 } }),
      input(),
      WS,
    );
    expect(run.status).toBe("timeout");
  });

  it("retries 429 with retry-after seconds on chat", async () => {
    const client = fakeClient({
      chat: [
        () => Promise.reject(apiError(429, "slow down", { "retry-after": "0" })),
        () => chatCalls([{ name: "submit_review", args: PASS }]),
      ],
    });
    const run = await runner(client, compatConn()).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(client.chatBodies).toHaveLength(2);
  });

  it("drops strict from chat tools after a strict rejection", async () => {
    const strictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary", "findings"],
      properties: {
        verdict: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
      },
    };
    const client = fakeClient({
      chat: [
        () => Promise.reject(apiError(400, "Unrecognized request argument supplied: strict")),
        () => chatCalls([{ name: "submit_review", args: PASS }]),
      ],
    });
    const run = await runner(client, compatConn({ options: { strict: true } })).r.run(
      seat(),
      input({ outputSchema: strictSchema }),
      WS,
    );
    expect(run.status).toBe("ok");
    expect(JSON.stringify(client.chatBodies[0]?.tools)).toContain('"strict":true');
    expect(JSON.stringify(client.chatBodies[1]?.tools)).not.toContain("strict");
  });

  it("never sends strict to a gateway unless options.strict is set", async () => {
    const strictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary", "findings"],
      properties: {
        verdict: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
      },
    };
    const client = fakeClient({ chat: [() => chatCalls([{ name: "submit_review", args: PASS }])] });
    await runner(client, compatConn()).r.run(seat(), input({ outputSchema: strictSchema }), WS);
    expect(JSON.stringify(client.chatBodies[0]?.tools)).not.toContain("strict");
  });

  it("does not replay an empty assistant turn; the nudge goes as a user message only", async () => {
    const client = fakeClient({
      chat: [
        () => ({
          choices: [{ finish_reason: "length", message: { content: null } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        () => chatCalls([{ name: "submit_review", args: PASS }]),
      ],
    });
    const run = await runner(client, compatConn()).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    const msgs = client.chatBodies[1]?.messages ?? [];
    expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => m.role === "assistant")).toBe(false);
    expect(msgs[2]?.role).toBe("user");
  });

  it("synthesises ids for tool calls without one", async () => {
    const client = fakeClient({
      chat: [
        () => chatCalls([{ name: "read_file", args: { path: "a" }, id: "" }]),
        () => chatCalls([{ name: "submit_review", args: PASS }]),
      ],
    });
    const run = await runner(client, compatConn()).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(client.chatBodies[1]?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "contents of a",
    });
  });
});

describe("secret safety", () => {
  it("never puts the API key in run.error", async () => {
    const client = fakeClient({
      responses: [() => Promise.reject(apiError(401, `Incorrect API key provided: ${API_KEY}`))],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(run.error).not.toContain(API_KEY);
    expect(run.error).toMatch(/401/);
  });

  it("redacts the key from unexpected errors and bad requests", async () => {
    for (const err of [new Error(`boom ${API_KEY}`), apiError(400, `bad key ${API_KEY}`)]) {
      const client = fakeClient({ responses: [() => Promise.reject(err)] });
      const run = await runner(client).r.run(seat(), input(), WS);
      expect(run.status).toBe("error");
      expect(run.error).not.toContain(API_KEY);
      expect(run.error).toContain("[REDACTED]");
    }
  });

  it("redacts custom header secrets on compatible connections", async () => {
    const headerSecret = "hdr-secret-value-987654";
    const conn = compatConn({
      secret: { kind: "openai-compatible", baseUrl: "https://gw.example/v1", headers: { "X-Api-Token": headerSecret } },
    });
    const client = fakeClient({ chat: [() => Promise.reject(new Error(`proxy said ${headerSecret}`))] });
    const run = await runner(client, conn).r.run(seat(), input(), WS);
    expect(run.error).not.toContain(headerSecret);
  });

  it("never throws, even when the client factory throws", async () => {
    const r = openaiProvider({
      clientFactory: () => {
        throw new Error(`bad config ${API_KEY}`);
      },
    }).createRunner(apiKeyConn(), MODEL, {});
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(run.error).not.toContain(API_KEY);
  });
});
