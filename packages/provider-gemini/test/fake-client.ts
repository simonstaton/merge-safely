import type { GenerateContentParameters, Part } from "@google/genai";
import type { GeminiModel, GeminiResult, GenAILike } from "../src/client.js";

type Step = (params: GenerateContentParameters) => GeminiResult | Promise<GeminiResult>;

export interface FakeGenAI extends GenAILike {
  requests: GenerateContentParameters[];
}

export function fakeGenAI(opts: { steps?: Step[]; models?: () => Promise<GeminiModel[]> }): FakeGenAI {
  const requests: GenerateContentParameters[] = [];
  let i = 0;
  return {
    requests,
    models: {
      list: async () => {
        const items = opts.models ? await opts.models() : [];
        return (async function* () {
          yield* items;
        })();
      },
      generateContent: async (params) => {
        const { config, ...rest } = params;
        const { abortSignal: _s, ...cfg } = config ?? {};
        requests.push({ ...structuredClone(rest), config: structuredClone(cfg) });
        const step = opts.steps?.[Math.min(i++, (opts.steps?.length ?? 1) - 1)];
        if (!step) throw new Error("no scripted response");
        // Give the step access to the live signal for hang/timeout tests.
        return step(params);
      },
    },
  };
}

export function usage(prompt: number, out: number, cached = 0, thoughts = 0): GeminiResult["usageMetadata"] {
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: out,
    cachedContentTokenCount: cached,
    thoughtsTokenCount: thoughts,
  };
}

export function modelParts(parts: Part[], u = usage(100, 20), finishReason = "STOP"): GeminiResult {
  return { candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: u };
}

export function call(name: string, args: Record<string, unknown>, id?: string): Part {
  return { functionCall: { name, args, ...(id ? { id } : {}) } };
}
