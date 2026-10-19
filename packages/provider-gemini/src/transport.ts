import { type Content, type FunctionDeclaration, type Part, type ThinkingConfig, ThinkingLevel } from "@google/genai";
import type { Logger } from "@merge-safely/core";
import type { GenAILike } from "./client.js";
import type { NormalizedCall, ToolResultMessage, Transport, TransportInit, TurnResult } from "./common/loop.js";
import { baseModelId } from "./models.js";

const BUDGETS: Record<string, number> = { minimal: 0, low: 1_024, medium: 8_192, high: 24_576 };
const LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Map a seat's effort to Gemini thinking config: thinkingLevel for 3.x, thinkingBudget for 2.5.
 * 2.5 Pro cannot disable thinking, so "minimal" becomes its 128-token floor.
 */
export function thinkingConfigFor(
  model: string,
  effort: string | undefined,
  logger?: Logger,
): ThinkingConfig | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  const id = baseModelId(model);
  if (/^gemini-[3-9]/.test(id)) {
    const level = LEVELS[e];
    if (level) return { thinkingLevel: level };
  } else if (id.startsWith("gemini-2.5")) {
    const budget = BUDGETS[e];
    if (budget !== undefined) return { thinkingBudget: id.includes("pro") ? Math.max(128, budget) : budget };
  }
  logger?.warn("effort not supported for this Gemini model; ignored", { model, effort });
  return undefined;
}

const FILTERED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/**
 * Gemini generateContent transport with function declarations. The model's content is appended to
 * the history verbatim so thought signatures on function-call parts survive between turns.
 */
export class GeminiTransport implements Transport {
  private readonly contents: Content[];
  private readonly declarations: FunctionDeclaration[];
  private readonly thinking: ThinkingConfig | undefined;
  /** Call ids we synthesised (Gemini often omits ids); these are not echoed back as functionResponse.id. */
  private readonly synthetic = new Set<string>();
  private seq = 0;

  constructor(
    private readonly client: GenAILike,
    private readonly model: string,
    private readonly init: TransportInit,
    logger?: Logger,
  ) {
    this.contents = [{ role: "user", parts: [{ text: init.user }] }];
    this.declarations = init.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));
    this.thinking = thinkingConfigFor(model, init.effort, logger);
  }

  async send(signal: AbortSignal): Promise<TurnResult> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: this.contents,
      config: {
        systemInstruction: this.init.system,
        tools: [{ functionDeclarations: this.declarations }],
        abortSignal: signal,
        ...(this.thinking ? { thinkingConfig: this.thinking } : {}),
      },
    });
    const cand = res.candidates?.[0];
    const parts: Part[] = cand?.content?.parts ?? [];
    const calls: NormalizedCall[] = [];
    let text = "";
    for (const p of parts) {
      if (p.functionCall) {
        let id = p.functionCall.id;
        if (!id) {
          id = `gemini_call_${++this.seq}`;
          this.synthetic.add(id);
        }
        calls.push({ id, name: p.functionCall.name ?? "", rawArgs: "", args: p.functionCall.args ?? {} });
      } else if (p.text && !p.thought) {
        text += p.text;
      }
    }
    if (parts.length > 0) this.contents.push({ role: "model", parts });

    const u = res.usageMetadata;
    const cached = u?.cachedContentTokenCount ?? 0;
    const usage = u
      ? {
          in: Math.max(0, (u.promptTokenCount ?? 0) - cached),
          // Thinking tokens are billed as output.
          out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          cachedIn: cached,
        }
      : { in: 0, out: 0 };
    const fr = cand?.finishReason;
    const stopReason: TurnResult["stopReason"] =
      calls.length > 0
        ? "tool_calls"
        : res.promptFeedback?.blockReason || (fr && FILTERED.has(fr))
          ? "filtered"
          : fr === "MAX_TOKENS"
            ? "length"
            : fr === "STOP"
              ? "stop"
              : "other";
    return { calls, text, usage, stopReason };
  }

  pushToolResults(results: ToolResultMessage[]): void {
    this.contents.push({
      role: "user",
      parts: results.map((r) => ({
        functionResponse: {
          ...(this.synthetic.has(r.callId) ? {} : { id: r.callId }),
          name: r.name,
          response: r.isError ? { error: r.output } : { output: r.output },
        },
      })),
    });
  }

  pushUserText(text: string): void {
    this.contents.push({ role: "user", parts: [{ text }] });
  }
}
