import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions/completions";
import type { ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";
import type { ChatResult, OpenAILike, ResponsesResult } from "../src/client.js";

type Step<B, R> = (body: B, signal?: AbortSignal) => R | Promise<R>;

export interface FakeClient extends OpenAILike {
  responseBodies: ResponseCreateParamsNonStreaming[];
  chatBodies: ChatCompletionCreateParamsNonStreaming[];
}

export function fakeClient(opts: {
  responses?: Array<Step<ResponseCreateParamsNonStreaming, ResponsesResult>>;
  chat?: Array<Step<ChatCompletionCreateParamsNonStreaming, ChatResult>>;
  models?: () => Promise<{ data: Array<{ id: string }> }>;
}): FakeClient {
  const responseBodies: ResponseCreateParamsNonStreaming[] = [];
  const chatBodies: ChatCompletionCreateParamsNonStreaming[] = [];
  let r = 0;
  let c = 0;
  return {
    responseBodies,
    chatBodies,
    models: { list: opts.models ?? (async () => ({ data: [] })) },
    responses: {
      create: async (body, o) => {
        responseBodies.push(structuredClone(body));
        const step = opts.responses?.[Math.min(r++, (opts.responses?.length ?? 1) - 1)];
        if (!step) throw new Error("no scripted response");
        return step(body, o?.signal);
      },
    },
    chat: {
      completions: {
        create: async (body, o) => {
          chatBodies.push(structuredClone(body));
          const step = opts.chat?.[Math.min(c++, (opts.chat?.length ?? 1) - 1)];
          if (!step) throw new Error("no scripted chat response");
          return step(body, o?.signal);
        },
      },
    },
  };
}

export function rUsage(input: number, output: number, cached = 0): ResponsesResult["usage"] {
  return { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached } };
}

export function rCall(name: string, args: unknown, id = `call_${name}`): ResponseOutputItem {
  return {
    type: "function_call",
    call_id: id,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

export function rMessage(text: string): ResponseOutputItem {
  return {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function responses(output: ResponseOutputItem[], usage = rUsage(100, 20)): ResponsesResult {
  return { output, status: "completed", usage };
}

export function chatCalls(
  calls: Array<{ name: string; args: unknown; id?: string }>,
  usage = { prompt_tokens: 100, completion_tokens: 20 },
): ChatResult {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage,
  };
}

export function chatText(text: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): ChatResult {
  return { choices: [{ finish_reason: "stop", message: { content: text } }], usage };
}
