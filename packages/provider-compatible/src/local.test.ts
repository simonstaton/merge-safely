import type { Connection } from "@merge-safely/core";
import { clientConfig, KEYLESS_PLACEHOLDER, type OpenAILike } from "@merge-safely/provider-openai";
import { describe, expect, it } from "vitest";
import { conn, input, model, PASS, seat, ws } from "../test/helpers.js";
import {
  asLocalModel,
  isLocalConnection,
  isPrivateHost,
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
  // Tier comes from the registry entry for the preset's own provider id; only Ollama has local entries.
  { name: "ollama", make: ollamaProvider, base: OLLAMA_BASE_URL, llamaTier: "small" },
  { name: "lmstudio", make: lmstudioProvider, base: LMSTUDIO_BASE_URL, llamaTier: "mid" },
])("$name preset", ({ name, make, base, llamaTier }) => {
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
    expect(byName["llama3.1:8b"]).toMatchObject({ zeroCost: true, tier: llamaTier, provider: name });
    expect(byName["llama3.1:8b"]?.pricing).toBeUndefined();
    expect(byName["my-finetune"]).toMatchObject({ zeroCost: true, tier: "mid" });
    expect(byName["gpt-oss:120b-cloud"]?.zeroCost).not.toBe(true);
    expect(byName["gpt-oss:120b-cloud"]?.pricing).toBeDefined();
  });

  it("prices models on a remote host; options.zeroCost overrides either way", async () => {
    const rec = recorder();
    const p = make({ clientFactory: fakeFactory(["gpt-oss:120b", "llama3.1:8b"], rec) });
    const remote = conn({
      provider: name,
      secret: { kind: "openai-compatible", baseUrl: "https://ollama.com/v1", apiKey: "remote-key-123456" },
    });
    for (const m of await p.models(remote)) {
      expect(m.zeroCost).not.toBe(true);
      expect(m.pricing).toBeDefined();
    }
    const optIn = { ...keyless(name, "http://gpu-box.lan:11434/v1"), options: { zeroCost: true } };
    expect((await p.models(optIn)).every((m) => m.zeroCost === true)).toBe(true);
    const optOut = { ...keyless(name), options: { zeroCost: false } };
    expect((await p.models(optOut)).some((m) => m.zeroCost === true)).toBe(false);
  });

  it("refuses secrets of other kinds instead of sending them to api.openai.com", async () => {
    const rec = recorder();
    const p = make({ clientFactory: fakeFactory(["llama3.1:8b"], rec) });
    const apiKey = conn({ provider: name, secret: { kind: "api-key", apiKey: "sk-real-0123456789" } });
    const v = await p.validate(apiKey);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/not supported/);
    expect(JSON.stringify(v)).not.toContain("sk-real-0123456789");
    await expect(p.models(apiKey)).rejects.toThrow(/not supported/);
    expect(() => p.createRunner(apiKey, model())).toThrow(/not supported/);
    expect(rec.conns).toHaveLength(0);
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

  it("throws for other secret kinds", () => {
    const c = conn({ provider: "ollama", secret: { kind: "api-key", apiKey: "k-123456789" } });
    expect(() => withLocalDefaults(c, OLLAMA_BASE_URL)).toThrow(/not supported/);
  });
});

describe("asLocalModel", () => {
  it("drops pricing and sets zeroCost on a local connection", () => {
    const m = asLocalModel(model({ provider: "ollama", name: "deepseek-r1:14b", tier: "frontier" }));
    expect(m).toMatchObject({ zeroCost: true, tier: "mid" });
    expect(m.pricing).toBeUndefined();
  });

  it("keeps or adds pricing when not local", () => {
    const { pricing: _p, ...unpriced } = model({ provider: "ollama", name: "qwen3-coder:480b", zeroCost: true });
    const m = asLocalModel(unpriced, false);
    expect(m.zeroCost).toBeUndefined();
    expect(m.pricing?.inPerMTok).toBeGreaterThan(0);
  });
});

describe("isPrivateHost / isLocalConnection", () => {
  it.each([
    ["localhost", true],
    ["ollama.localhost", true],
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.9", true],
    ["172.32.0.1", false],
    ["192.168.1.20", true],
    ["169.254.10.10", true],
    ["[::1]", true],
    ["[fd12:3456::1]", true],
    ["[fe80::1]", true],
    ["[::ffff:192.168.0.2]", true],
    ["[2001:db8::1]", false],
    ["8.8.8.8", false],
    ["ollama.com", false],
    ["gpu-box.lan", false],
  ])("%s -> %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it("reads the connection's base URL", () => {
    expect(isLocalConnection(keyless("ollama", "http://[::1]:11434/v1"))).toBe(true);
    expect(isLocalConnection(keyless("ollama", "https://ollama.com/v1"))).toBe(false);
    expect(isLocalConnection(keyless("ollama", "not a url"))).toBe(false);
  });
});
