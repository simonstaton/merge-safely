import type { Logger } from "@merge-safely/core";
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import type { OpenAILike } from "./client.js";
import type { NormalizedCall, ToolResultMessage, Transport, TransportInit, TurnResult } from "./common/loop.js";
import { isSchemaRejection } from "./errors.js";

export const REASONING_EFFORTS: ReadonlyArray<Exclude<ReasoningEffort, null>> = ["minimal", "low", "medium", "high"];

export function toEffort(effort: string | undefined, logger?: Logger): Exclude<ReasoningEffort, null> | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  const hit = REASONING_EFFORTS.find((x) => x === e);
  if (!hit) logger?.warn("unknown reasoning effort ignored", { effort });
  return hit;
}

/** Reasoning-model families (no temperature; reasoning items must be carried between turns). */
export function isReasoningModel(name: string): boolean {
  return /^(o\d|gpt-5|codex)/i.test(name.replace(/^.*\//, ""));
}

/**
 * OpenAI Responses API transport. Stateless: `store: false`, the full item list is resent each turn
 * (model output replayed verbatim, then our function_call_output items), and reasoning items are
 * carried as encrypted content so nothing about the PR is retained server side.
 */
export class ResponsesTransport implements Transport {
  private readonly input: ResponseInputItem[];
  private tools: FunctionTool[];
  private readonly effort: Exclude<ReasoningEffort, null> | undefined;
  private readonly reasoning: boolean;

  constructor(
    private readonly client: OpenAILike,
    private readonly model: string,
    private readonly init: TransportInit,
    logger?: Logger,
  ) {
    this.input = [{ role: "user", content: init.user }];
    this.tools = init.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      // The Responses API defaults strict to true, so it is always set explicitly.
      strict: t.strict,
    }));
    this.effort = toEffort(init.effort, logger);
    this.reasoning = this.effort !== undefined || isReasoningModel(model);
  }

  async send(signal: AbortSignal): Promise<TurnResult> {
    const res = await this.client.responses.create(
      {
        model: this.model,
        instructions: this.init.system,
        input: this.input,
        tools: this.tools,
        store: false,
        ...(this.reasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
        ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
      },
      { signal },
    );
    const calls: NormalizedCall[] = [];
    let text = "";
    // Replay output items verbatim (ids, reasoning items, empty messages): with store:false an
    // encrypted reasoning item must be followed by the item it produced.
    const replay: ResponseInputItem[] = [];
    for (const item of res.output ?? []) {
      if (item.type === "function_call") {
        calls.push({ id: item.call_id, name: item.name, rawArgs: item.arguments ?? "" });
        replay.push(item);
      } else if (item.type === "message") {
        text += item.content
          .map((c) => (c.type === "output_text" ? c.text : c.type === "refusal" ? c.refusal : ""))
          .join("");
        replay.push(item);
      } else if (item.type === "reasoning") {
        replay.push(item);
      }
    }
    // A trailing reasoning item with nothing after it (e.g. an incomplete response) cannot be replayed.
    while (replay.length > 0 && replay[replay.length - 1]?.type === "reasoning") replay.pop();
    this.input.push(...replay);
    const u = res.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const usage = u
      ? { in: Math.max(0, u.input_tokens - cached), out: u.output_tokens, cachedIn: cached }
      : { in: 0, out: 0 };
    const stopReason: TurnResult["stopReason"] =
      calls.length > 0
        ? "tool_calls"
        : res.status === "incomplete"
          ? res.incomplete_details?.reason === "content_filter"
            ? "filtered"
            : "length"
          : "stop";
    return { calls, text, usage, stopReason };
  }

  pushToolResults(results: ToolResultMessage[]): void {
    for (const r of results) this.input.push({ type: "function_call_output", call_id: r.callId, output: r.output });
  }

  pushUserText(text: string): void {
    this.input.push({ role: "user", content: text });
  }

  recover(err: unknown): boolean {
    if (!isSchemaRejection(err) || !this.tools.some((t) => t.strict)) return false;
    this.tools = this.tools.map((t) => ({ ...t, strict: false }));
    return true;
  }
}
