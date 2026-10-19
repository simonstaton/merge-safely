import {
  extractJson,
  type JudgeOutput,
  type Logger,
  type ModelInfo,
  parseJudgeOutput,
  parseReviewerOutput,
  type ReviewerInput,
  type ReviewerOutput,
  type ReviewerRun,
  type RunnerOptions,
  type RunStatus,
  type Seat,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResult,
  type WorkspaceHandle,
} from "@merge-safely/core";
import { RunGuard } from "./guard.js";
import { errorMessage, redact } from "./redact.js";
import {
  AbortedError,
  abortable,
  type ErrorClassifier,
  NonRetryableError,
  RetriesExhaustedError,
  type RetryOptions,
  withRetry,
} from "./retry.js";
import { isStrictCompatible, sanitizeSchema } from "./schema.js";

/**
 * Provider-neutral agentic review loop. A Transport owns the wire format and conversation state for
 * one run; the loop owns tools, budgets, retries, schema validation and the audit.
 */

export const SUBMIT_TOOL = "submit_review";
/** Invalid submissions tolerated before the run is schema-invalid (so at most MAX + 1 attempts). */
export const MAX_INVALID_SUBMISSIONS = 2;

export interface NeutralTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Request provider-side strict schema adherence (only set when the schema permits it). */
  strict: boolean;
}

export interface NormalizedCall {
  id: string;
  name: string;
  /** Raw argument text as sent by the model (JSON). */
  rawArgs: string;
  /** Already-decoded arguments when the wire format provides objects (Gemini). */
  args?: Record<string, unknown>;
}

export interface TurnResult {
  calls: NormalizedCall[];
  text: string;
  usage: TokenUsage;
  stopReason: "tool_calls" | "stop" | "length" | "filtered" | "other";
}

export interface ToolResultMessage {
  callId: string;
  name: string;
  output: string;
  isError: boolean;
}

export interface Transport {
  /** Send the current conversation; on success append the assistant turn to the conversation. */
  send(signal: AbortSignal): Promise<TurnResult>;
  pushToolResults(results: ToolResultMessage[]): void;
  pushUserText(text: string): void;
  /**
   * Called when `send` failed permanently. Return true when the transport changed its request
   * (e.g. dropped strict schemas) and the same turn should be attempted again.
   */
  recover?(err: unknown): boolean;
}

export interface TransportInit {
  system: string;
  user: string;
  tools: NeutralTool[];
  effort?: string;
}

export interface LoopConfig {
  model: ModelInfo;
  options: RunnerOptions;
  classify: ErrorClassifier;
  /** Strings that must never appear in errors or logs (API keys, tokens, header values). */
  secrets: string[];
  retry?: RetryOptions;
  /** Whether the provider supports strict function schemas at all. */
  supportsStrict: boolean;
  makeTransport(init: TransportInit): Transport;
}

export function toolDescription(): string {
  return (
    "Submit your final review. Call this exactly once, when your investigation is complete. " +
    "The arguments are your entire answer and must satisfy the parameter schema. Do not reply with plain text."
  );
}

function nudge(reason: string): string {
  return `${reason} You must finish by calling the ${SUBMIT_TOOL} function with arguments that satisfy its schema.`;
}

type Outcome =
  | { kind: "ok"; output: ReviewerOutput | null; judgeOutput: JudgeOutput | null }
  | { kind: "fail"; status: RunStatus; error: string };

export class AgenticLoop {
  constructor(private readonly cfg: LoopConfig) {}

  private get logger(): Logger | undefined {
    return this.cfg.options.logger;
  }

  private safe(text: string): string {
    return redact(text, this.cfg.secrets);
  }

  async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
    const startedAt = new Date();
    const t0 = Date.now();
    const guard = new RunGuard(seat.budget, this.cfg.model, signal, this.logger);
    let executor: ToolExecutor | undefined;
    let outcome: Outcome;
    try {
      executor = this.cfg.options.tools?.(ws, { allowedCommands: input.allowedCommands });
      if (!executor) this.logger?.warn("no tool executor supplied; reviewer runs without workspace tools");
      outcome = await this.loop(seat, input, guard, executor);
    } catch (err: unknown) {
      outcome = this.failureFromError(err, guard);
    } finally {
      guard.dispose();
    }

    let work: ReturnType<ToolExecutor["audit"]> = {
      substantiveCalls: 0,
      totalCalls: 0,
      filesRead: [],
      commandsRun: [],
    };
    try {
      if (executor) work = executor.audit();
    } catch (err: unknown) {
      this.logger?.warn("tool executor audit failed", { error: this.safe(errorMessage(err)) });
    }
    const isJudge = seat.role === "judge";
    const run: ReviewerRun = {
      seat,
      headSha: input.change.headSha,
      round: input.round,
      output: outcome.kind === "ok" ? outcome.output : null,
      audit: {
        ...work,
        tokens: guard.tokens,
        costUsd: guard.usd,
        wallMs: Date.now() - t0,
        turns: guard.turns,
      },
      status: outcome.kind === "ok" ? "ok" : outcome.status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
    if (isJudge) run.judgeOutput = outcome.kind === "ok" ? outcome.judgeOutput : null;
    if (outcome.kind === "fail") run.error = this.safe(outcome.error);
    return run;
  }

  private buildTools(input: ReviewerInput, executor: ToolExecutor | undefined): NeutralTool[] {
    const defs: ToolDefinition[] = executor?.definitions() ?? [];
    const tools: NeutralTool[] = [];
    for (const d of defs) {
      if (d.name === SUBMIT_TOOL) {
        this.logger?.warn(`tool executor defines reserved tool name ${SUBMIT_TOOL}; ignoring it`);
        continue;
      }
      tools.push({
        name: d.name,
        description: d.description,
        parameters: sanitizeSchema(d.inputSchema),
        strict: false,
      });
    }
    const schema = sanitizeSchema(input.outputSchema);
    tools.push({
      name: SUBMIT_TOOL,
      description: toolDescription(),
      parameters: schema,
      strict: this.cfg.supportsStrict && isStrictCompatible(schema),
    });
    return tools;
  }

  private validate(seat: Seat, raw: unknown): Extract<Outcome, { kind: "ok" }> | { kind: "invalid"; error: string } {
    if (seat.role === "judge") {
      const r = parseJudgeOutput(raw);
      return r.ok ? { kind: "ok", output: null, judgeOutput: r.value } : { kind: "invalid", error: r.error };
    }
    const r = parseReviewerOutput(raw);
    return r.ok ? { kind: "ok", output: r.value, judgeOutput: null } : { kind: "invalid", error: r.error };
  }

  private decodeArgs(
    call: NormalizedCall,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    if (call.args) return { ok: true, value: call.args };
    if (!call.rawArgs.trim()) return { ok: true, value: {} };
    try {
      const v: unknown = JSON.parse(call.rawArgs);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
      return { ok: false, error: "arguments must be a JSON object" };
    } catch {
      return { ok: false, error: "arguments were not valid JSON" };
    }
  }

  private budgetExceeded(guard: RunGuard): Outcome {
    const max = guard.budget.maxUsd ?? 0;
    return {
      kind: "fail",
      status: "budget-exceeded",
      error:
        `Seat spend limit of $${max.toFixed(2)} reached ($${(guard.usd ?? 0).toFixed(4)} spent over ${guard.turns} turns) ` +
        "before a review was submitted. This is a budget stop, not a crash. Recovery: raise the per-seat budget " +
        "(policy budget.perSeatUsd) or choose a cheaper model, then re-run the check.",
    };
  }

  private turnsExceeded(guard: RunGuard): Outcome {
    return {
      kind: "fail",
      status: "budget-exceeded",
      error:
        `Turn limit of ${guard.budget.maxTurns} reached before a review was submitted. This is a budget stop, ` +
        "not a crash. Recovery: raise the seat's maxTurns in policy, then re-run the check.",
    };
  }

  private async loop(seat: Seat, input: ReviewerInput, guard: RunGuard, executor?: ToolExecutor): Promise<Outcome> {
    const tools = this.buildTools(input, executor);
    const known = new Set(tools.map((t) => t.name));
    const transport = this.cfg.makeTransport({
      system: input.prompt.system,
      user: input.prompt.user,
      tools,
      effort: seat.model.effort,
    });
    let invalid = 0;
    let lastInvalid = "";

    for (;;) {
      if (guard.turnsExhausted()) return this.turnsExceeded(guard);
      if (guard.overBudget()) return this.budgetExceeded(guard);

      const turn = await this.send(transport, guard);
      guard.turns++;
      const usd = guard.addUsage(turn.usage);
      try {
        this.cfg.options.onUsage?.({ tokens: turn.usage, usd });
      } catch (err: unknown) {
        this.logger?.warn("onUsage callback threw", { error: this.safe(errorMessage(err)) });
      }

      const submit = turn.calls.find((c) => c.name === SUBMIT_TOOL);
      let submitError: string | undefined;
      if (submit) {
        const args = this.decodeArgs(submit);
        const v = args.ok ? this.validate(seat, args.value) : { kind: "invalid" as const, error: args.error };
        // A valid submission is honoured even if this final response pushed spend over the cap:
        // the tokens are already paid for and the cap is checked before every further request.
        if (v.kind === "ok") return v;
        invalid++;
        lastInvalid = v.error;
        submitError = v.error;
        this.logger?.info("reviewer submitted invalid output", { attempt: invalid });
        if (invalid > MAX_INVALID_SUBMISSIONS) {
          return { kind: "fail", status: "schema-invalid", error: `output failed schema validation: ${lastInvalid}` };
        }
      }

      // Spend cap: stop before executing tools or sending another request.
      if (guard.overBudget()) return this.budgetExceeded(guard);

      if (turn.calls.length > 0) {
        const results: ToolResultMessage[] = [];
        for (const call of turn.calls) {
          if (call.name === SUBMIT_TOOL) {
            results.push({
              callId: call.id,
              name: call.name,
              isError: true,
              output:
                `ERROR: submission rejected, it does not satisfy the schema: ${submitError ?? "duplicate submission"}. ` +
                `Fix the listed problems and call ${SUBMIT_TOOL} again (${MAX_INVALID_SUBMISSIONS + 1 - invalid} attempts left).`,
            });
            continue;
          }
          results.push(await this.execTool(call, known, guard, executor));
        }
        transport.pushToolResults(results);
        continue;
      }

      // Plain-text stop: try to salvage JSON from the text before nudging.
      if (turn.text.trim()) {
        const raw = extractJson(turn.text);
        if (raw !== undefined) {
          const v = this.validate(seat, raw);
          if (v.kind === "ok") return v;
          lastInvalid = v.error;
        } else {
          lastInvalid = "no JSON object found in the final message";
        }
      } else {
        lastInvalid =
          turn.stopReason === "length" ? "response was cut off at the output token limit" : "empty response";
      }
      invalid++;
      if (invalid > MAX_INVALID_SUBMISSIONS) {
        return { kind: "fail", status: "schema-invalid", error: `no valid review was submitted: ${lastInvalid}` };
      }
      transport.pushUserText(nudge(`Your last reply did not submit a review (${lastInvalid}).`));
    }
  }

  private async send(transport: Transport, guard: RunGuard): Promise<TurnResult> {
    let recovered = 0;
    for (;;) {
      try {
        return await withRetry(() => transport.send(guard.signal), {
          classify: this.cfg.classify,
          signal: guard.signal,
          retry: this.cfg.retry,
          logger: this.logger,
          label: "model call",
        });
      } catch (err: unknown) {
        const cause = err instanceof NonRetryableError ? err : undefined;
        if (cause && recovered < 2 && transport.recover?.(err)) {
          recovered++;
          this.logger?.warn("provider rejected the request shape; retrying with a relaxed request");
          continue;
        }
        throw err;
      }
    }
  }

  private async execTool(
    call: NormalizedCall,
    known: Set<string>,
    guard: RunGuard,
    executor?: ToolExecutor,
  ): Promise<ToolResultMessage> {
    const base = { callId: call.id, name: call.name };
    if (!executor || !known.has(call.name)) {
      return { ...base, isError: true, output: `ERROR: unknown tool "${call.name}". Use only the tools provided.` };
    }
    const args = this.decodeArgs(call);
    if (!args.ok) return { ...base, isError: true, output: `ERROR: ${args.error}` };
    const tc: ToolCall = { id: call.id, name: call.name, input: args.value };
    let result: ToolResult;
    try {
      result = await abortable(executor.execute(tc, guard.signal), guard.signal);
    } catch (err: unknown) {
      if (err instanceof AbortedError) throw err;
      result = { ok: false, output: `tool failed: ${this.safe(errorMessage(err))}` };
    }
    try {
      this.cfg.options.onToolCall?.(tc, result);
    } catch (err: unknown) {
      this.logger?.warn("onToolCall callback threw", { error: this.safe(errorMessage(err)) });
    }
    return { ...base, isError: !result.ok, output: result.ok ? result.output : `ERROR: ${result.output}` };
  }

  private failureFromError(err: unknown, guard: RunGuard): Outcome {
    if (err instanceof AbortedError || guard.stopReason) {
      if (guard.stopReason === "timeout") {
        return {
          kind: "fail",
          status: "timeout",
          error: `Seat deadline of ${guard.budget.deadlineMs}ms reached after ${guard.turns} turns.`,
        };
      }
      return { kind: "fail", status: "error", error: "run aborted by caller" };
    }
    if (err instanceof RetriesExhaustedError) return { kind: "fail", status: "error", error: err.message };
    if (err instanceof NonRetryableError) return { kind: "fail", status: "error", error: err.info.message };
    return { kind: "fail", status: "error", error: `runner error: ${this.safe(errorMessage(err))}` };
  }
}
