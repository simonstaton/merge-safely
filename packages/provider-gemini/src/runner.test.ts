import type { Content } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { call, fakeGenAI, modelParts, usage } from "../test/fake-client.js";
import {
  API_KEY,
  apiError,
  apiKeyConn,
  BLOCK,
  fakeTools,
  hang,
  input,
  MODEL,
  PASS,
  seat,
  WS,
} from "../test/helpers.js";
import type { GenAILike } from "./client.js";
import { geminiProvider } from "./provider.js";

function runner(client: GenAILike, model = MODEL) {
  const tools = fakeTools();
  const onUsage = vi.fn();
  const r = geminiProvider({ clientFactory: () => client, retry: { baseDelayMs: 1, maxDelayMs: 2 } }).createRunner(
    apiKeyConn(),
    model,
    { tools: tools.factory, onUsage },
  );
  return { r, tools, onUsage };
}

const lastContent = (c: GenAILike & { requests: Array<{ contents: unknown }> }, i: number): Content[] =>
  c.requests[i]?.contents as Content[];

describe("gemini runner", () => {
  it("executes tool calls, then accepts submit_review", async () => {
    const client = fakeGenAI({
      steps: [
        () =>
          modelParts(
            [{ text: "thinking", thought: true, thoughtSignature: "sig-1" }, call("read_file", { path: "src/x.ts" })],
            usage(1_000, 50, 200, 30),
          ),
        () => modelParts([call("submit_review", PASS, "fc-2")], usage(2_000, 40)),
      ],
    });
    const { r, tools, onUsage } = runner(client);
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("pass");
    expect(tools.calls).toEqual([{ id: "gemini_call_1", name: "read_file", input: { path: "src/x.ts" } }]);
    expect(run.audit).toMatchObject({ totalCalls: 1, filesRead: ["src/x.ts"], turns: 2 });
    // in excludes cached; out includes thoughts
    expect(run.audit.tokens).toEqual({ in: 800 + 2_000, out: 80 + 40, cachedIn: 200 });
    expect(run.audit.costUsd).toBeGreaterThan(0);
    expect(onUsage).toHaveBeenCalledTimes(2);

    const req0 = client.requests[0];
    expect(req0?.model).toBe("gemini-2.5-pro");
    expect(req0?.config?.systemInstruction).toBe("SYSTEM PROMPT");
    expect(req0?.config).not.toHaveProperty("responseSchema");
    expect(req0?.config).not.toHaveProperty("temperature");
    const decls = req0?.config?.tools?.[0];
    expect(decls && "functionDeclarations" in decls ? decls.functionDeclarations?.map((d) => d.name) : []).toEqual([
      "read_file",
      "submit_review",
    ]);
    const submitDecl = decls && "functionDeclarations" in decls ? decls.functionDeclarations?.[1] : undefined;
    expect(JSON.stringify(submitDecl?.parametersJsonSchema)).not.toContain("$schema");

    const contents1 = lastContent(client, 1);
    // model turn echoed verbatim (thought signature preserved), then the function response
    expect(contents1[1]?.parts?.[0]?.thoughtSignature).toBe("sig-1");
    const fr = contents1[2]?.parts?.[0]?.functionResponse;
    expect(fr).toEqual({ name: "read_file", response: { output: "contents of src/x.ts" } });
  });

  it("echoes model-provided call ids on function responses", async () => {
    const client = fakeGenAI({
      steps: [
        () => modelParts([call("read_file", { path: "a" }, "fc-1")]),
        () => modelParts([call("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(lastContent(client, 1)[2]?.parts?.[0]?.functionResponse?.id).toBe("fc-1");
  });

  it("returns a block", async () => {
    const client = fakeGenAI({ steps: [() => modelParts([call("submit_review", BLOCK)])] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(run.output?.findings).toHaveLength(1);
  });

  it("validates judge output", async () => {
    const client = fakeGenAI({
      steps: [() => modelParts([call("submit_review", { votes: [{ findingId: "f", decision: "refute" }] })])],
    });
    const run = await runner(client).r.run(seat({ role: "judge" }), input(), WS);
    expect(run.status).toBe("ok");
    expect(run.judgeOutput?.votes[0]?.decision).toBe("refute");
  });

  it("feeds an invalid submission back and accepts the retry", async () => {
    const client = fakeGenAI({
      steps: [
        () => modelParts([call("submit_review", { verdict: "pass" })]),
        () => modelParts([call("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    const fr = lastContent(client, 1)[2]?.parts?.[0]?.functionResponse;
    expect(JSON.stringify(fr?.response)).toContain("submission rejected");
    expect(fr?.response).toHaveProperty("error");
  });

  it("is schema-invalid after repeated invalid submissions", async () => {
    const client = fakeGenAI({ steps: [() => modelParts([call("submit_review", { nope: true })])] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("schema-invalid");
    expect(client.requests).toHaveLength(3);
  });

  it("salvages JSON from text and nudges on MALFORMED_FUNCTION_CALL", async () => {
    const client = fakeGenAI({
      steps: [
        () => modelParts([], usage(10, 0), "MALFORMED_FUNCTION_CALL"),
        () => modelParts([{ text: `result: ${JSON.stringify(PASS)}` }]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(JSON.stringify(lastContent(client, 1))).toContain("submit_review");
  });

  it("stops with budget-exceeded once maxUsd is crossed", async () => {
    const client = fakeGenAI({ steps: [() => modelParts([call("read_file", { path: "a" })], usage(1_000_000, 0))] });
    const { r, tools } = runner(client);
    const run = await r.run(seat({ budget: { maxTurns: 50, deadlineMs: 10_000, maxUsd: 0.5 } }), input(), WS);
    expect(run.status).toBe("budget-exceeded");
    expect(run.error).toMatch(/Recovery/);
    expect(tools.calls).toHaveLength(0);
  });

  it("times out", async () => {
    const client = fakeGenAI({ steps: [(p) => hang(p.config?.abortSignal)] });
    const run = await runner(client).r.run(seat({ budget: { maxTurns: 5, deadlineMs: 40 } }), input(), WS);
    expect(run.status).toBe("timeout");
  });

  it("retries 429 using RetryInfo.retryDelay, then succeeds", async () => {
    const client = fakeGenAI({
      steps: [
        () => Promise.reject(apiError(429, '{"error":{"code":429,"details":[{"retryDelay":"0.001s"}]}}')),
        () => Promise.reject(apiError(503, "UNAVAILABLE")),
        () => modelParts([call("submit_review", PASS)]),
      ],
    });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("ok");
    expect(client.requests).toHaveLength(3);
  });

  it("gives up after 3 retries", async () => {
    const client = fakeGenAI({ steps: [() => Promise.reject(apiError(500, "INTERNAL"))] });
    const run = await runner(client).r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(client.requests).toHaveLength(4);
  });

  it("passes thinking config from effort", async () => {
    const client = fakeGenAI({ steps: [() => modelParts([call("submit_review", PASS)])] });
    await runner(client).r.run(
      seat({ model: { connectionId: "c", provider: "gemini", name: "gemini-2.5-pro", effort: "medium" } }),
      input(),
      WS,
    );
    expect(client.requests[0]?.config?.thinkingConfig).toEqual({ thinkingBudget: 8_192 });
  });

  it("never leaks the key in errors", async () => {
    for (const err of [apiError(400, `API key not valid: ${API_KEY}`), new Error(`boom ?key=${API_KEY}`)]) {
      const client = fakeGenAI({ steps: [() => Promise.reject(err)] });
      const run = await runner(client).r.run(seat(), input(), WS);
      expect(run.status).toBe("error");
      expect(run.error).not.toContain(API_KEY);
    }
  });

  it("never throws when the factory throws", async () => {
    const r = geminiProvider({
      clientFactory: () => {
        throw new Error(`nope ${API_KEY}`);
      },
    }).createRunner(apiKeyConn(), MODEL);
    const run = await r.run(seat(), input(), WS);
    expect(run.status).toBe("error");
    expect(run.error).not.toContain(API_KEY);
  });
});
