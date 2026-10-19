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
import { MessagesRunner, SUBMIT_REVIEW_TOOL } from "./messages-runner.js";

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

  it("salvages JSON from final text once, else schema-invalid", async () => {
    const ok = new FakeClient([
      message([text(`Done:\n\`\`\`json\n${JSON.stringify(PASS_OUTPUT)}\n\`\`\``)], "end_turn"),
    ]);
    expect((await runner(ok).r.run(seat(), input(), ws())).status).toBe("ok");
    const bad = new FakeClient([message([text("I think it is fine.")], "end_turn")]);
    const run = await runner(bad).r.run(seat(), input(), ws());
    expect(run.status).toBe("schema-invalid");
    expect(run.error).toContain(SUBMIT_REVIEW_TOOL);
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

  it("warns when maxUsd cannot be enforced for an unpriced model", async () => {
    const warn = vi.fn();
    const client = new FakeClient([message([toolUse(SUBMIT_REVIEW_TOOL, PASS_OUTPUT)], "tool_use")]);
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const run = await runner(client, { logger }, model({ pricing: undefined })).r.run(
      seat({}, { maxUsd: 1 }),
      input(),
      ws(),
    );
    expect(run.status).toBe("ok");
    expect(run.audit.costUsd).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maxUsd cannot be enforced"), expect.anything());
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
