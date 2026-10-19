import type { Connection } from "@merge-safely/core";
import { clientConfig, KEYLESS_PLACEHOLDER, type OpenAILike } from "@merge-safely/provider-openai";
import { describe, expect, it } from "vitest";
import { conn, input, model, PASS, seat, ws } from "../test/helpers.js";
import {
  asLocalModel,
  LMSTUDIO_BASE_URL,
  lmstudioProvider,
  OLLAMA_BASE_URL,
  ollamaProvider,
  withLocalDefaults,
} from "./local.js";

interface Recorder {
  conns: Connection[];
  chatBodies: unknown[];
  responsesCalls: number;
}

/** A fake OpenAI client: lists the given model ids and answers chat with a submit_review tool call. */
function fakeFactory(ids: string[], rec: Recorder) {
  return (c: Connection): OpenAILike => {
    rec.conns.push(c);
    return {
      models: { list: async () => ({ data: ids.map((id) => ({ id })) }) },
      responses: {
        create: async () => {
          rec.responsesCalls++;
          throw new Error("responses API not expected for a local preset");
        },
      },
      chat: {
        completions: {
          create: async (body) => {
            rec.chatBodies.push(body);
            return {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function" as const,
                        function: { name: "submit_review", arguments: JSON.stringify(PASS) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            };
          },
        },
      },
    };
  };
}

const recorder = (): Recorder => ({ conns: [], chatBodies: [], responsesCalls: 0 });
const keyless = (provider: string, baseUrl = "") => conn({ provider, secret: { kind: "openai-compatible", baseUrl } });

describe.each([
  { name: "ollama", make: ollamaProvider, base: OLLAMA_BASE_URL },
  { name: "lmstudio", make: lmstudioProvider, base: LMSTUDIO_BASE_URL },
])("$name preset", ({ name, make, base }) => {
  it("declares its id and accepts only openai-compatible", () => {
    const p = make();
    expect(p.id).toBe(name);
    expect(p.connectionKinds).toEqual(["openai-compatible"]);
  });

  it("fills the default base URL, keeps an explicit one, and needs no key", async () => {
    const rec = recorder();
    const p = make({ clientFactory: fakeFactory(["llama3.1:8b"], rec) });
    await p.models(keyless(name));
    await p.models(keyless(name, "http://gpu-box.lan:8080/v1"));
    expect(rec.conns.map((c) => (c.secret.kind === "openai-compatible" ? c.secret.baseUrl : ""))).toEqual([
      base,
      "http://gpu-box.lan:8080/v1",
    ]);
    const cfg = clientConfig(rec.conns[0] as Connection);
    expect(cfg.apiKey).toBe(KEYLESS_PLACEHOLDER);
    expect(cfg.baseURL).toBe(base);
  });

  it("marks listed models zero-cost, registry tier when known else mid, priced when a -cloud tag", async () => {
    const rec = recorder();
    const p = make({ clientFactory: fakeFactory(["llama3.1:8b", "my-finetune", "gpt-oss:120b-cloud"], rec) });
    const v = await p.validate(keyless(name));
    expect(v.ok).toBe(true);
    const byName = Object.fromEntries((v.models ?? []).map((m) => [m.name, m]));
    expect(byName["llama3.1:8b"]).toMatchObject({ zeroCost: true, tier: "small" });
    expect(byName["llama3.1:8b"]?.pricing).toBeUndefined();
    expect(byName["my-finetune"]).toMatchObject({ zeroCost: true, tier: "mid" });
    expect(byName["gpt-oss:120b-cloud"]?.zeroCost).not.toBe(true);
    expect(byName["gpt-oss:120b-cloud"]?.pricing).toBeDefined();
  });

  it("runs over Chat Completions at zero cost", async () => {
    const rec = recorder();
    const p = make({ clientFactory: fakeFactory([], rec) });
    const usage: number[] = [];
    const runner = p.createRunner(keyless(name), model({ provider: name, name: "qwen3-coder" }), {
      onUsage: (d) => usage.push(d.usd ?? -1),
    });
    const run = await runner.run(seat(), input(), ws());
    expect(run.output?.verdict).toBe("pass");
    expect(rec.chatBodies).toHaveLength(1);
    expect(rec.responsesCalls).toBe(0);
    expect(run.audit.costUsd ?? 0).toBe(0);
    expect(usage.every((u) => u === 0)).toBe(true);
  });
});

describe("withLocalDefaults", () => {
  it("defaults the wire API to chat but honours an explicit responses opt-in", () => {
    expect(withLocalDefaults(keyless("ollama"), OLLAMA_BASE_URL).options?.api).toBe("chat");
    const opted = withLocalDefaults({ ...keyless("ollama"), options: { api: "responses" } }, OLLAMA_BASE_URL);
    expect(opted.options?.api).toBe("responses");
  });

  it("leaves other secret kinds untouched", () => {
    const c = conn({ provider: "ollama", secret: { kind: "api-key", apiKey: "k-123456789" } });
    expect(withLocalDefaults(c, OLLAMA_BASE_URL)).toBe(c);
  });
});

describe("asLocalModel", () => {
  it("drops pricing and sets zeroCost", () => {
    const m = asLocalModel(model({ provider: "ollama", name: "deepseek-r1:14b", tier: "frontier" }));
    expect(m).toMatchObject({ zeroCost: true, tier: "mid" });
    expect(m.pricing).toBeUndefined();
  });
});
