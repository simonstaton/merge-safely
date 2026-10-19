import type { Logger } from "@merge-safely/core";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import type { OpenAILike } from "./client.js";
import type { NormalizedCall, ToolResultMessage, Transport, TransportInit, TurnResult } from "./common/loop.js";
import { isSchemaRejection } from "./errors.js";
import { toEffort } from "./transport-responses.js";

/**
 * Chat Completions transport with `tools` function calling. The lowest common denominator spoken by
 * OpenRouter, Together, Ollama, LM Studio, vLLM and most gateways.
 */
export class ChatTransport implements Transport {
  private readonly messages: ChatCompletionMessageParam[];
  private tools: ChatCompletionFunctionTool[];
  private readonly effort: ReturnType<typeof toEffort>;
  private callSeq = 0;

  constructor(
    private readonly client: OpenAILike,
    private readonly model: string,
    init: TransportInit,
    logger?: Logger,
  ) {
    this.messages = [
      { role: "system", content: init.system },
      { role: "user", content: init.user },
    ];
    this.tools = init.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        // Only sent when true: many compatible servers reject the field outright.
        ...(t.strict ? { strict: true } : {}),
      },
    }));
    this.effort = toEffort(init.effort, logger);
  }

  async send(signal: AbortSignal): Promise<TurnResult> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.messages,
        tools: this.tools,
        ...(this.effort ? { reasoning_effort: this.effort } : {}),
      },
      { signal },
    );
    const choice = res.choices[0];
    const msg = choice?.message;
    const fnCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      // Some local servers omit ids; synthesise stable ones so results can be matched.
      fnCalls.push({ ...tc, id: tc.id || `call_${++this.callSeq}` });
    }
    const text = msg?.content ?? "";
    this.messages.push({
      role: "assistant",
      content: msg?.content ?? null,
      ...(fnCalls.length > 0 ? { tool_calls: fnCalls } : {}),
    });
    const calls: NormalizedCall[] = fnCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      rawArgs: c.function.arguments ?? "",
    }));
    const u = res.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = u
      ? { in: Math.max(0, u.prompt_tokens - cached), out: u.completion_tokens, cachedIn: cached }
      : { in: 0, out: 0 };
    const fr = choice?.finish_reason;
    const stopReason: TurnResult["stopReason"] =
      calls.length > 0
        ? "tool_calls"
        : fr === "length"
          ? "length"
          : fr === "content_filter"
            ? "filtered"
            : fr === "stop"
              ? "stop"
              : "other";
    return { calls, text, usage, stopReason };
  }

  pushToolResults(results: ToolResultMessage[]): void {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.callId, content: r.output });
  }

  pushUserText(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  recover(err: unknown): boolean {
    if (!isSchemaRejection(err) || !this.tools.some((t) => t.function.strict)) return false;
    this.tools = this.tools.map((t) => {
      const { strict: _drop, ...fn } = t.function;
      return { ...t, function: fn };
    });
    return true;
  }
}
