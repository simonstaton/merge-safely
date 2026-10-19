import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "@merge-safely/core";
import { describe, expect, it, vi } from "vitest";
import {
  API_KEY,
  conn,
  FakeClient,
  FakeExecutor,
  input,
  message,
  model,
  PASS_OUTPUT,
  seat,
  text,
  toolUse,
  ws,
} from "../test/helpers.js";
import { MessagesRunner, NUDGE_TEXT, SUBMIT_REVIEW_TOOL } from "./messages-runner.js";

const noSleep = { sleep: async () => {}, retryBaseMs: 1 };

function runner(client: FakeClient, opts: ConstructorParameters<typeof MessagesRunner>[3] = {}, m = model()) {
  let executor: FakeExecutor | undefined;
  const r = new MessagesRunner(
    client,
    conn(),
    m,
    {
      tools: (_ws, o) => {
        executor = new FakeExecutor(o);
        return executor;
      },
      ...opts,
    },
    noSleep,
  );
  return { r, executor: () => executor };
}

describe("MessagesRunner", () => {
  it("runs tools, then accepts submit_review", async () => {
    const client = new FakeClient([
      message([text("Let me look."), toolUse("read_file", { path: "src/a.ts" })], "tool_use"),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use", { cache_read_input_tokens: 900 }),
    ]);
    const deltas: { tokens: TokenUsage; usd?: number }[] = [];
    const { r, executor } = runner(client, { onUsage: (d) => deltas.push(d) });
    const run = await r.run(seat(), input(), ws());

    expect(run.status).toBe("ok");
    expect(run.output).toMatchObject({ verdict: "pass", summary: "Looks fine." });
    expect(run.headSha).toBe("abc123");
    expect(executor()?.opts?.allowedCommands).toEqual(["npm test"]);
    expect(executor()?.calls).toHaveLength(1);
    expect(run.audit).toMatchObject({ turns: 2, substantiveCalls: 1, filesRead: ["src/a.ts"] });
    expect(run.audit.tokens).toMatchObject({ in: 2000, out: 200, cachedIn: 900 });
    expect(deltas).toHaveLength(2);
    // 1000 in * $2 + 100 out * $10 per MTok = $0.003 per turn, plus 900 cached * $0.2 on the second.
    expect(run.audit.costUsd).toBeCloseTo(0.006 + 0.00018, 8);

    // Request shape: cached system + first user block, tools include submit_review with the output schema.
    const body = client.bodies[0];
    expect(body?.max_tokens).toBe(16_000);
    expect(body?.tool_choice).toEqual({ type: "auto" });
    const sys = body?.system as Anthropic.TextBlockParam[];
    expect(sys[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(sys[0]?.text).toContain("You are the correctness lens.");
    const first = body?.messages[0]?.content as Anthropic.TextBlockParam[];
    expect(first[0]?.cache_control).toEqual({ type: "ephemeral" });
    const submit = body?.tools?.find((t) => "name" in t && t.name === SUBMIT_REVIEW_TOOL) as Anthropic.Tool;
    expect(submit.input_schema.required).toEqual(["verdict", "summary", "findings"]);
    expect(submit.input_schema).not.toHaveProperty("$schema");
    // Second request carries the tool result for read_file.
    const second = client.bodies[1]?.messages;
    const toolResults = second?.[2]?.content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0]).toMatchObject({ type: "tool_result", content: "contents of src/a.ts" });
  });

  it("validates judge output with the judge schema", async () => {
    const client = new FakeClient([
      message([toolUse(SUBMIT_REVIEW_TOOL, { votes: [{ findingId: "f1", decision: "confirm" }] })], "tool_use"),
    ]);
    const { r } = runner(client);
    const run = await r.run(seat({ role: "judge", id: "judge:1" }), input({ outputSchema: {} }), ws());
    expect(run.status).toBe("ok");
    expect(run.output).toBeNull();
    expect(run.judgeOutput?.votes[0]).toMatchObject({ findingId: "f1", decision: "confirm" });
    const submit = client.bodies[0]?.tools?.find((t) => "name" in t && t.name === SUBMIT_REVIEW_TOOL) as Anthropic.Tool;
    expect(submit.input_schema.required).toEqual(["votes"]);
  });

  it("returns schema errors to the model and lets it retry", async () => {
    const client = new FakeClient([
      message([toolUse(SUBMIT_REVIEW_TOOL, { verdict: "maybe", summary: "x", findings: [] })], "tool_use"),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const { r } = runner(client);
    const run = await r.run(seat(), input(), ws());
    expect(run.status).toBe("ok");
    const retry = client.bodies[1]?.messages[2]?.content as Anthropic.ToolResultBlockParam[];
    expect(retry[0]?.is_error).toBe(true);
    expect(String(retry[0]?.content)).toContain("verdict");
  });

  it("gives up after two schema retries", async () => {
    const bad = () => message([toolUse(SUBMIT_REVIEW_TOOL, { verdict: "pass" })], "tool_use");
    const client = new FakeClient([bad(), bad(), bad(), bad()]);
    const { r } = runner(client);
    const run = await r.run(seat(), input(), ws());
    expect(run.status).toBe("schema-invalid");
    expect(run.output).toBeNull();
    expect(run.audit.turns).toBe(3);
    expect(run.error).toContain("summary");
  });

  it("salvages JSON from final text, else nudges once, then schema-invalid", async () => {
    const ok = new FakeClient([
      message([text(`Done:\n\`\`\`json\n${JSON.stringify(PASS_OUTPUT)}\n\`\`\``)], "end_turn"),
    ]);
    expect((await runner(ok).r.run(seat(), input(), ws())).status).toBe("ok");

    const recovers = new FakeClient([
      message([text("I think it is fine.")], "end_turn"),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const r1 = await runner(recovers).r.run(seat(), input(), ws());
    expect(r1.status).toBe("ok");
    const nudge = recovers.bodies[1]?.messages.at(-1)?.content as Anthropic.TextBlockParam[];
    expect(nudge.at(-1)?.text).toBe(NUDGE_TEXT);

    const bad = new FakeClient([message([text("fine")], "end_turn"), message([text("still fine")], "end_turn")]);
    const run = await runner(bad).r.run(seat(), input(), ws());
    expect(run.status).toBe("schema-invalid");
    expect(run.error).toContain(SUBMIT_REVIEW_TOOL);
    expect(bad.bodies).toHaveLength(2);
  });

  it("never executes tool calls truncated by max_tokens; nudges instead", async () => {
    const client = new FakeClient([
      message([toolUse("read_file", { pa: "" }), toolUse(SUBMIT_REVIEW_TOOL, { verdict: "pass" })], "max_tokens"),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const { r, executor } = runner(client);
    const run = await r.run(seat(), input(), ws());
    expect(run.status).toBe("ok");
    expect(executor()?.calls).toHaveLength(0);
    const reply = client.bodies[1]?.messages.at(-1)?.content as Anthropic.ContentBlockParam[];
    expect(reply.filter((b) => b.type === "tool_result")).toHaveLength(2);
    expect(reply.every((b) => b.type !== "tool_result" || b.is_error === true)).toBe(true);
  });

  it("accepts a valid submission and ignores other calls in the same response", async () => {
    const client = new FakeClient([
      message([toolUse("read_file", { path: "late.ts" }), toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const { r, executor } = runner(client);
    const run = await r.run(seat(), input(), ws());
    expect(run.status).toBe("ok");
    expect(executor()?.calls).toHaveLength(0);
    expect(run.audit.totalCalls).toBe(0);
  });

  it("moves the message cache breakpoint to the latest user message", async () => {
    const client = new FakeClient([
      message([toolUse("read_file", { path: "a" })], "tool_use"),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    await runner(client).r.run(seat(), input(), ws());
    const marked = (msgs: Anthropic.MessageParam[]) =>
      msgs.flatMap((m, i) =>
        typeof m.content === "string"
          ? []
          : m.content.filter((b) => "cache_control" in b && b.cache_control).map(() => i),
      );
    expect(marked(client.bodies[0]?.messages ?? [])).toEqual([0]);
    expect(marked(client.bodies[1]?.messages ?? [])).toEqual([2]);
    const system = (client.bodies[1]?.system ?? []) as Anthropic.TextBlockParam[];
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends effort only when the model supports it", async () => {
    const s = seat({ model: { connectionId: "c", provider: "anthropic", name: "m", effort: "high" } });
    const supported = new FakeClient([message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use")]);
    await runner(supported, {}, model({ effortLevels: ["low", "high"] })).r.run(s, input(), ws());
    expect(supported.bodies[0]).toMatchObject({ output_config: { effort: "high" } });
    const unsupported = new FakeClient([message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use")]);
    await runner(unsupported, {}, model({ effortLevels: undefined })).r.run(s, input(), ws());
    expect(unsupported.bodies[0]).not.toHaveProperty("output_config");
  });

  it("stops at maxTurns with a budget-exceeded recovery message", async () => {
    const loop = () => message([toolUse("read_file", { path: "a" })], "tool_use");
    const client = new FakeClient([loop(), loop(), loop()]);
    const run = await runner(client).r.run(seat({}, { maxTurns: 2 }), input(), ws());
    expect(run.status).toBe("budget-exceeded");
    expect(run.audit.turns).toBe(2);
    expect(run.error).toMatch(/maxTurns/);
  });

  it("stops at maxUsd with recovery text, after streaming the usage", async () => {
    const client = new FakeClient([
      message([toolUse("read_file", { path: "a" })], "tool_use", { input_tokens: 1_000_000, output_tokens: 0 }),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const onUsage = vi.fn();
    const run = await runner(client, { onUsage }).r.run(seat({}, { maxUsd: 1 }), input(), ws());
    expect(run.status).toBe("budget-exceeded");
    expect(run.output).toBeNull();
    expect(run.error).toContain("raise the per-seat USD ceiling");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]?.[0]?.usd).toBeCloseTo(2, 6);
    expect(run.audit.costUsd).toBeCloseTo(2, 6);
  });

  it("prices an unpriced model pessimistically so maxUsd still enforces", async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const client = new FakeClient([
      message([toolUse("read_file", { path: "a" })], "tool_use", { input_tokens: 200_000, output_tokens: 0 }),
      message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use"),
    ]);
    const run = await runner(client, { logger }, model({ name: "anthropic/claude-new-9", pricing: undefined })).r.run(
      seat({}, { maxUsd: 1 }),
      input(),
      ws(),
    );
    // 200k input tokens at the most expensive known input rate (>= $10/MTok) is at least $2.
    expect(run.status).toBe("budget-exceeded");
    expect(run.audit.costUsd).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pessimistic"), expect.anything());
  });

  it("times out at the seat deadline", async () => {
    const slow = (_b: unknown, signal?: AbortSignal) =>
      new Promise<Anthropic.Message>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
      });
    const client = new FakeClient([slow]);
    const run = await runner(client).r.run(seat({}, { deadlineMs: 50 }), input(), ws());
    expect(run.status).toBe("timeout");
    expect(run.output).toBeNull();
  });

  it("honours an external abort signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = await runner(new FakeClient([])).r.run(seat(), input(), ws(), ac.signal);
    expect(run.status).toBe("error");
    expect(run.error).toContain("aborted");
  });

  it("retries 429 honouring retry-after, then succeeds", async () => {
    const sleeps: number[] = [];
    const rateLimited = new Anthropic.RateLimitError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      "rate limited",
      new Headers({ "retry-after": "2" }),
    );
    const client = new FakeClient([rateLimited, message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use")]);
    const r = new MessagesRunner(
      client,
      conn(),
      model(),
      {},
      { sleep: async (ms) => void sleeps.push(ms), retryBaseMs: 10 },
    );
    const run = await r.run(seat({}, { deadlineMs: 60_000 }), input(), ws());
    expect(run.status).toBe("ok");
    expect(sleeps).toEqual([2000]);
    expect(run.audit.turns).toBe(1);
  });

  it("never waits less than retry-after, even above the backoff cap", async () => {
    const sleeps: number[] = [];
    const e = new Anthropic.RateLimitError(429, undefined, "rl", new Headers({ "retry-after": "90" }));
    const client = new FakeClient([e, message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use")]);
    const r = new MessagesRunner(
      client,
      conn(),
      model(),
      {},
      { sleep: async (ms) => void sleeps.push(ms), maxRetryWaitMs: 1000 },
    );
    expect((await r.run(seat({}, { deadlineMs: 600_000 }), input(), ws())).status).toBe("ok");
    expect(sleeps).toEqual([90_000]);
  });

  it("scrubs secrets from the submitted review", async () => {
    const leaky = { verdict: "pass", summary: `saw ${API_KEY}`, findings: [] };
    const run = await runner(new FakeClient([message([toolUse(SUBMIT_REVIEW_TOOL, leaky)], "tool_use")])).r.run(
      seat(),
      input(),
      ws(),
    );
    expect(run.output?.summary).toBe("saw [REDACTED]");
  });

  it("gives up after 3 retries on 5xx / network errors", async () => {
    const e = () => new Anthropic.InternalServerError(503, undefined, "unavailable", new Headers());
    const client = new FakeClient([e(), new Anthropic.APIConnectionError({ message: "ECONNRESET" }), e(), e(), e()]);
    const run = await runner(client).r.run(seat(), input(), ws());
    expect(run.status).toBe("error");
    expect(run.error).toContain("after 4 attempt(s)");
    expect(client.bodies).toHaveLength(4);
  });

  it("does not wait past the deadline for a retry", async () => {
    const e = new Anthropic.RateLimitError(429, undefined, "rl", new Headers({ "retry-after": "600" }));
    const run = await new MessagesRunner(new FakeClient([e]), conn(), model(), {}, noSleep).run(
      seat({}, { deadlineMs: 5_000 }),
      input(),
      ws(),
    );
    expect(run.status).toBe("timeout");
  });

  it("never leaks the API key in errors", async () => {
    const e = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${API_KEY}` } },
      `401 invalid key ${API_KEY}`,
      new Headers(),
    );
    const bad = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: `echo ${API_KEY}` } },
      "bad",
      new Headers(),
    );
    for (const err of [e, bad, new Error(`kaboom ${API_KEY}`)]) {
      const run = await runner(new FakeClient([err])).r.run(seat(), input(), ws());
      expect(run.status).toBe("error");
      expect(run.error).toBeDefined();
      expect(run.error).not.toContain(API_KEY);
      expect(JSON.stringify(run)).not.toContain(API_KEY);
    }
  });

  it("runs without an executor (submit only) and reports refusals", async () => {
    const client = new FakeClient([message([text("no")], "refusal")]);
    const run = await new MessagesRunner(client, conn(), model(), {}, noSleep).run(seat(), input(), ws());
    expect(run.status).toBe("error");
    expect(run.audit).toMatchObject({ substantiveCalls: 0, totalCalls: 0, turns: 1 });
  });
});
