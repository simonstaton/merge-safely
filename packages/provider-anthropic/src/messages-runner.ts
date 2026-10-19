import type Anthropic from "@anthropic-ai/sdk";
import {
  type Connection,
  extractJson,
  type ModelInfo,
  type ModelRunner,
  type ReviewerInput,
  type ReviewerRun,
  type RunnerOptions,
  type RunStatus,
  type Seat,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResult,
  type ToolUseAudit,
  type WorkspaceHandle,
} from "@merge-safely/core";
import { classifyExit } from "./classify.js";
import { type AnthropicLike, describeApiError } from "./client.js";
import { addUsage, priceUsage, ZERO_USAGE } from "./models.js";
import { buildRun, outputSchemaFor, type ParsedOutput, parseForSeat } from "./output.js";
import { scrub, secretValues } from "./secrets.js";

export const SUBMIT_REVIEW_TOOL = "submit_review";
export const MAX_SCHEMA_RETRIES = 2;
export const MAX_OUTPUT_TOKENS_CAP = 16_000;

export interface MessagesRunnerConfig {
  /** Retries for 429 / 529 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** First backoff step in ms (doubles each retry, with jitter). Default 1000. */
  retryBaseMs?: number;
  /** Upper bound for a single backoff wait. Default 60s. */
  maxRetryWaitMs?: number;
  /** Injectable for tests. Must reject when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const TOOL_PREAMBLE = [
  "",
  "## How to work",
  "You are running as a read-only reviewer inside a checkout of the change's head commit.",
  "Use the provided tools to investigate the code before you decide; claims must be grounded in what you read.",
  `When you are finished, call the \`${SUBMIT_REVIEW_TOOL}\` tool exactly once with your final result.`,
  `Its input must match the tool's schema exactly. Do not put the final result in plain text.`,
].join("\n");

/** Convert the shared tool definitions to Anthropic tool shapes. */
export function toAnthropicToolDefs(defs: readonly ToolDefinition[]): Anthropic.Tool[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: { ...d.inputSchema, type: "object" } as Anthropic.Tool.InputSchema,
  }));
}

export function submitReviewTool(seat: Seat, input: ReviewerInput): Anthropic.Tool {
  return {
    name: SUBMIT_REVIEW_TOOL,
    description:
      seat.role === "judge"
        ? "Submit your final votes on the candidate findings. Call exactly once, when you are done investigating."
        : "Submit your final review verdict and findings. Call exactly once, when you are done investigating.",
    input_schema: outputSchemaFor(seat, input) as Anthropic.Tool.InputSchema,
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function usageFrom(u: Anthropic.Usage | undefined): TokenUsage {
  return {
    in: u?.input_tokens ?? 0,
    out: u?.output_tokens ?? 0,
    cachedIn: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Assistant content as request params, passed back unchanged (thinking blocks must round-trip). */
function toParams(content: Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  return content.map((b): Anthropic.ContentBlockParam => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      case "thinking":
        return { type: "thinking", thinking: b.thinking, signature: b.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: b.data };
      default:
        // Block types newer than this SDK version are replayed verbatim.
        return b as unknown as Anthropic.ContentBlockParam;
    }
  });
}

class StopRun extends Error {
  constructor(
    readonly status: RunStatus,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Messages API runner: an agentic loop over the shared read-only tool set plus a `submit_review` tool whose
 * input schema is the seat's output schema. Enforces turns, deadline and USD budgets itself and never throws.
 */
export class MessagesRunner implements ModelRunner {
  private readonly secrets: string[];
  private readonly cfg: Required<Omit<MessagesRunnerConfig, "sleep" | "now">> &
    Pick<Required<MessagesRunnerConfig>, "sleep" | "now">;
  private warnedUnpriced = false;

  constructor(
    private readonly client: AnthropicLike,
    conn: Connection,
    private readonly model: ModelInfo,
    private readonly opts: RunnerOptions = {},
    cfg: MessagesRunnerConfig = {},
  ) {
    this.secrets = secretValues(conn);
    this.cfg = {
      maxRetries: cfg.maxRetries ?? 3,
      retryBaseMs: cfg.retryBaseMs ?? 1000,
      maxRetryWaitMs: cfg.maxRetryWaitMs ?? 60_000,
      sleep: cfg.sleep ?? defaultSleep,
      now: cfg.now ?? Date.now,
    };
  }

  async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
    const startedAt = new Date();
    const t0 = this.cfg.now();
    let tokens: TokenUsage = { ...ZERO_USAGE };
    let usd: number | undefined = this.model.zeroCost ? 0 : undefined;
    let turns = 0;
    let executor: ToolExecutor | undefined;
    let parsed: ParsedOutput | undefined;
    let status: RunStatus = "ok";
    let error: string | undefined;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, seat.budget.deadlineMs),
    );
    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const deadlineAt = t0 + seat.budget.deadlineMs;
    const stopForAbort = (): never => {
      const c = classifyExit({ timedOut, aborted: !timedOut, deadlineMs: seat.budget.deadlineMs });
      throw new StopRun(c.status, c.error ?? "aborted");
    };

    try {
      if (!this.model.zeroCost && !this.model.pricing && seat.budget.maxUsd !== undefined) {
        this.warnUnpriced(seat);
      }
      executor = this.opts.tools?.(ws, { allowedCommands: input.allowedCommands });
      if (!executor) {
        this.opts.logger?.warn("anthropic: no tool executor configured; the seat can only submit a review", {
          seat: seat.id,
        });
      }
      const tools = [...toAnthropicToolDefs(executor?.definitions() ?? []), submitReviewTool(seat, input)];
      const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: `${input.prompt.system}\n${TOOL_PREAMBLE}`, cache_control: { type: "ephemeral" } },
      ];
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: [{ type: "text", text: input.prompt.user, cache_control: { type: "ephemeral" } }] },
      ];
      const maxTokens = Math.max(
        1,
        Math.min(this.model.maxOutputTokens || MAX_OUTPUT_TOKENS_CAP, MAX_OUTPUT_TOKENS_CAP),
      );
      let schemaFailures = 0;

      while (!parsed?.ok) {
        if (controller.signal.aborted) stopForAbort();
        if (turns >= seat.budget.maxTurns) {
          const c = classifyExit({ budgetHit: "turns", maxTurns: seat.budget.maxTurns });
          throw new StopRun(c.status, c.error ?? "turn budget exhausted");
        }
        const body: Anthropic.MessageCreateParamsNonStreaming = {
          model: this.model.name,
          max_tokens: maxTokens,
          system,
          tools,
          tool_choice: { type: "auto" },
          messages,
        };
        if (seat.model.effort) {
          (body as unknown as Record<string, unknown>).output_config = { effort: seat.model.effort };
        }
        const response = await this.createWithRetry(body, controller.signal, deadlineAt, () => timedOut);
        turns++;

        const delta = usageFrom(response.usage);
        tokens = addUsage(tokens, delta);
        const deltaUsd = this.model.zeroCost ? 0 : priceUsage(this.model.pricing, delta);
        if (deltaUsd !== undefined) usd = (usd ?? 0) + deltaUsd;
        this.opts.onUsage?.({ tokens: delta, ...(deltaUsd !== undefined ? { usd: deltaUsd } : {}) });

        messages.push({ role: "assistant", content: toParams(response.content) });
        const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

        if (seat.budget.maxUsd !== undefined && usd !== undefined && usd >= seat.budget.maxUsd) {
          const c = classifyExit({ budgetHit: "usd", usd, maxUsd: seat.budget.maxUsd });
          throw new StopRun(c.status, c.error ?? "usd budget exhausted");
        }
        if (response.stop_reason === "refusal") throw new StopRun("error", "model declined the request (refusal)");

        if (toolUses.length === 0) {
          // The model ended without submitting. One salvage attempt from the final text, then schema-invalid.
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const raw = extractJson(text);
          const r = raw === undefined ? undefined : parseForSeat(seat, raw);
          if (r?.ok) {
            parsed = r;
            break;
          }
          throw new StopRun(
            "schema-invalid",
            `model stopped (${response.stop_reason ?? "unknown"}) without calling ${SUBMIT_REVIEW_TOOL}` +
              (r && !r.ok ? `; final text failed validation: ${r.error}` : "; no JSON found in final text"),
          );
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          if (controller.signal.aborted) stopForAbort();
          if (tu.name === SUBMIT_REVIEW_TOOL) {
            const r = parseForSeat(seat, tu.input);
            if (r.ok) {
              parsed = r;
              results.push({ type: "tool_result", tool_use_id: tu.id, content: "Review received." });
              continue;
            }
            schemaFailures++;
            if (schemaFailures > MAX_SCHEMA_RETRIES) {
              throw new StopRun("schema-invalid", `submit_review input failed validation: ${r.error}`);
            }
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content:
                `Your ${SUBMIT_REVIEW_TOOL} input did not match the schema: ${r.error}. ` +
                `Fix exactly these problems and call ${SUBMIT_REVIEW_TOOL} again ` +
                `(${MAX_SCHEMA_RETRIES - schemaFailures + 1} attempt(s) left).`,
            });
            continue;
          }
          results.push(await this.execTool(executor, tu, controller.signal));
        }
        if (parsed?.ok) break;
        messages.push({ role: "user", content: results });
      }
    } catch (err: unknown) {
      if (err instanceof StopRun) {
        status = err.status;
        error = scrub(err.message, this.secrets);
      } else {
        status = "error";
        error = scrub(`anthropic runner failed: ${err instanceof Error ? err.message : String(err)}`, this.secrets);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }

    const audit: ToolUseAudit = {
      ...(executor?.audit() ?? { substantiveCalls: 0, totalCalls: 0, filesRead: [], commandsRun: [] }),
      tokens,
      wallMs: this.cfg.now() - t0,
      turns,
    };
    if (usd !== undefined) audit.costUsd = usd;
    return buildRun({
      seat,
      input,
      ws,
      parsed,
      audit,
      status,
      ...(error !== undefined ? { error } : {}),
      startedAt,
      finishedAt: new Date(),
    });
  }

  private warnUnpriced(seat: Seat): void {
    if (this.warnedUnpriced) return;
    this.warnedUnpriced = true;
    this.opts.logger?.warn("anthropic: model has no pricing; maxUsd cannot be enforced for this seat", {
      model: this.model.name,
      seat: seat.id,
    });
  }

  private async execTool(
    executor: ToolExecutor | undefined,
    tu: Anthropic.ToolUseBlock,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const call: ToolCall = {
      id: tu.id,
      name: tu.name,
      input: tu.input && typeof tu.input === "object" ? (tu.input as Record<string, unknown>) : {},
    };
    let result: ToolResult;
    if (!executor) {
      result = { ok: false, output: `Unknown tool "${tu.name}". Only ${SUBMIT_REVIEW_TOOL} is available.` };
    } else {
      try {
        result = await executor.execute(call, signal);
      } catch (err: unknown) {
        result = {
          ok: false,
          output: `tool failed: ${scrub(err instanceof Error ? err.message : String(err), this.secrets)}`,
        };
      }
    }
    this.opts.onToolCall?.(call, result);
    const content = result.truncated ? `${result.output}\n[output truncated]` : result.output;
    return { type: "tool_result", tool_use_id: tu.id, content, ...(result.ok ? {} : { is_error: true }) };
  }

  private async createWithRetry(
    body: Anthropic.MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    deadlineAt: number,
    timedOut: () => boolean,
  ): Promise<Anthropic.Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.messages.create(body, { signal });
      } catch (err: unknown) {
        const info = describeApiError(err);
        if (info.aborted || signal.aborted) {
          const c = classifyExit({ timedOut: timedOut(), aborted: !timedOut() });
          throw new StopRun(c.status, c.error ?? info.message);
        }
        if (!info.retryable || attempt >= this.cfg.maxRetries) {
          const suffix = info.retryable ? ` after ${attempt + 1} attempt(s)` : "";
          throw new StopRun("error", `${info.message}${suffix}`);
        }
        const backoff = this.cfg.retryBaseMs * 2 ** attempt * (0.8 + Math.random() * 0.4);
        const wait = Math.min(this.cfg.maxRetryWaitMs, Math.max(info.retryAfterMs ?? 0, backoff));
        if (this.cfg.now() + wait >= deadlineAt) {
          throw new StopRun(
            "timeout",
            `${info.message}; retry wait of ${Math.round(wait)}ms would pass the seat deadline`,
          );
        }
        this.opts.logger?.debug("anthropic: retrying", { status: info.status, attempt: attempt + 1, waitMs: wait });
        try {
          await this.cfg.sleep(wait, signal);
        } catch {
          const c = classifyExit({ timedOut: timedOut(), aborted: !timedOut() });
          throw new StopRun(c.status, c.error ?? "aborted");
        }
      }
    }
  }
}
