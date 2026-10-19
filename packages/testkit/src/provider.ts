import type {
  Connection,
  ConnectionKind,
  Finding,
  JudgeOutput,
  ModelInfo,
  ModelProvider,
  ModelRunner,
  ProviderId,
  ReviewerInput,
  ReviewerOutput,
  ReviewerRun,
  RunnerOptions,
  Seat,
  TokenUsage,
  ToolUseAudit,
  ValidationResult,
  WorkspaceHandle,
} from "@merge-safely/core";

/** What a script returns for one seat: a full output, a partial run to merge over the defaults, or an Error. */
export type ScriptResult = Partial<ReviewerRun> | ReviewerOutput | JudgeOutput | Error;
export type Script = (seat: Seat, input: ReviewerInput) => ScriptResult | Promise<ScriptResult>;

export interface FakeProviderOptions {
  /** Provider id. Default "fake". */
  id?: ProviderId;
  /** Default every kind. */
  connectionKinds?: ConnectionKind[];
  /** Default: hunters pass with no findings, judges confirm every candidate. */
  script?: Script;
  /** Returned by `models()` and `validate()`. Default `[fakeModel({ provider: id })]`. */
  models?: ModelInfo[];
  /** Override validation (e.g. `{ ok: false, message: "invalid key" }`). */
  validate?: ValidationResult | ((conn: Connection) => ValidationResult);
  /** Tokens for a run whose script does not set `audit.tokens`. Default `{ in: 1000, out: 200 }`. */
  tokens?: TokenUsage;
  /** Usage is streamed to `onUsage` in this many deltas summing to the run total. Default 2. */
  usageChunks?: number;
  /** Simulated latency per run, honouring the abort signal (an aborted run returns status "timeout"). */
  delayMs?: number;
  /** Clock for `startedAt`. Default the real clock. */
  now?: () => Date;
}

/** One recorded `run()` call. */
export interface FakeCall {
  seat: Seat;
  input: ReviewerInput;
  ws: WorkspaceHandle;
  connection: Connection;
  model: ModelInfo;
  run: ReviewerRun;
  /** Every usage delta streamed for this run, in order. */
  usage: Array<{ tokens: TokenUsage; usd?: number }>;
}

export interface FakeProvider extends ModelProvider {
  /** Every run, in completion order. */
  readonly calls: FakeCall[];
  /** Connections passed to `validate()`. */
  readonly validated: Connection[];
  /** Number of `createRunner()` calls. */
  runnersCreated: number;
  /** Clear `calls`, `validated` and `runnersCreated`. */
  reset(): void;
}

export const DEFAULT_TOKENS: TokenUsage = { in: 1000, out: 200 };
/** USD for a run when the model has neither pricing nor `zeroCost`. */
export const FALLBACK_USD = 0.01;
const PAD_FILES = ["README.md", "package.json", "src/index.ts"];

export function fakeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "fake",
    name: "fake-model",
    displayName: "Fake Model",
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    pricing: { inPerMTok: 1, outPerMTok: 5 },
    tier: "mid",
    source: "testkit",
    ...over,
  };
}

/** USD for a usage record: 0 for zero-cost models, list price when known, else `FALLBACK_USD`. */
export function fakeUsd(model: ModelInfo, tokens: TokenUsage): number {
  if (model.zeroCost) return 0;
  const p = model.pricing;
  if (!p) return FALLBACK_USD;
  return (
    (tokens.in * p.inPerMTok +
      tokens.out * p.outPerMTok +
      (tokens.cachedIn ?? 0) * (p.cachedInPerMTok ?? p.inPerMTok) +
      (tokens.cacheWrite ?? 0) * (p.cacheWritePerMTok ?? p.inPerMTok)) /
    1_000_000
  );
}

/** An audit that passes attestation: 5 substantive calls, 3 files read (changed files first). */
export function passingAudit(input: ReviewerInput, tokens: TokenUsage = DEFAULT_TOKENS): ToolUseAudit {
  const filesRead = [...new Set([...input.change.files.map((f) => f.path), ...PAD_FILES])].slice(0, 3);
  return { substantiveCalls: 5, totalCalls: 6, filesRead, commandsRun: [], tokens, wallMs: 1200, turns: 4 };
}

export function isJudgeOutput(r: unknown): r is JudgeOutput {
  return typeof r === "object" && r !== null && Array.isArray((r as { votes?: unknown }).votes);
}

export function isReviewerOutput(r: unknown): r is ReviewerOutput {
  const o = r as { verdict?: unknown; findings?: unknown };
  return typeof r === "object" && r !== null && typeof o.verdict === "string" && Array.isArray(o.findings);
}

export function passOutput(summary = "No issues found."): ReviewerOutput {
  return { verdict: "pass", summary, findings: [] };
}

export function confirmAll(candidates: Finding[] = []): JudgeOutput {
  return { votes: candidates.map((f) => ({ findingId: f.id, decision: "confirm" as const })), summary: "Confirmed." };
}

const defaultScript: Script = (seat, input) =>
  seat.role === "judge" ? confirmAll(input.candidateFindings) : passOutput();

function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function splitUsage(tokens: TokenUsage, usd: number, chunks: number): Array<{ tokens: TokenUsage; usd: number }> {
  const n = Math.max(1, Math.floor(chunks));
  const part = (total: number, i: number) => {
    const base = Math.floor(total / n);
    return i === n - 1 ? total - base * (n - 1) : base;
  };
  const out: Array<{ tokens: TokenUsage; usd: number }> = [];
  for (let i = 0; i < n; i++) {
    const t: TokenUsage = { in: part(tokens.in, i), out: part(tokens.out, i) };
    if (tokens.cachedIn !== undefined) t.cachedIn = part(tokens.cachedIn, i);
    if (tokens.cacheWrite !== undefined) t.cacheWrite = part(tokens.cacheWrite, i);
    out.push({ tokens: t, usd: i === n - 1 ? usd - (usd / n) * (n - 1) : usd / n });
  }
  return out;
}

const hasTokens = (t: TokenUsage) => t.in + t.out + (t.cachedIn ?? 0) + (t.cacheWrite ?? 0) > 0;

/**
 * A scriptable ModelProvider. Each `run()` asks the script for the seat's result, fills the rest of the
 * `ReviewerRun` with defaults that pass attestation, streams usage through `onUsage`, and records the call.
 */
export function fakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const id = opts.id ?? "fake";
  const models = opts.models ?? [fakeModel({ provider: id })];
  const script = opts.script ?? defaultScript;
  const now = opts.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  const validated: Connection[] = [];

  function buildRun(seat: Seat, input: ReviewerInput, result: ScriptResult, startedAt: Date): ReviewerRun {
    const base = (status: ReviewerRun["status"], audit: ToolUseAudit): ReviewerRun => ({
      seat,
      headSha: input.change.headSha,
      round: input.round,
      output: null,
      audit,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + audit.wallMs).toISOString(),
    });
    const tokens = opts.tokens ?? DEFAULT_TOKENS;

    if (result instanceof Error) {
      // Failed before doing any work: nothing read, nothing spent.
      const audit: ToolUseAudit = {
        ...passingAudit(input, { in: 0, out: 0 }),
        substantiveCalls: 0,
        totalCalls: 0,
        filesRead: [],
        turns: 0,
      };
      return {
        ...base("error", audit),
        error: result.message,
        ...(seat.role === "judge" ? { judgeOutput: null } : {}),
      };
    }
    if (isJudgeOutput(result)) {
      return { ...base("ok", passingAudit(input, tokens)), judgeOutput: result };
    }
    if (isReviewerOutput(result)) {
      return { ...base("ok", passingAudit(input, tokens)), output: result };
    }
    // Partial run: merge over the defaults (audit merged field by field).
    const audit = { ...passingAudit(input, tokens), ...(result.audit ?? {}) };
    const merged: ReviewerRun = { ...base("ok", audit), ...result, audit };
    if (result.startedAt && !result.finishedAt) {
      merged.finishedAt = new Date(Date.parse(result.startedAt) + audit.wallMs).toISOString();
    }
    if (!("output" in result) && !("judgeOutput" in result) && merged.status === "ok") {
      if (seat.role === "judge") merged.judgeOutput = confirmAll(input.candidateFindings);
      else merged.output = passOutput();
    }
    return merged;
  }

  return {
    id,
    connectionKinds: opts.connectionKinds ?? [
      "api-key",
      "openai-compatible",
      "anthropic-compatible",
      "oauth",
      "cloud",
      "subscription",
    ],
    calls,
    validated,
    runnersCreated: 0,

    reset() {
      calls.length = 0;
      validated.length = 0;
      this.runnersCreated = 0;
    },

    async validate(conn: Connection): Promise<ValidationResult> {
      validated.push(conn);
      if (typeof opts.validate === "function") return opts.validate(conn);
      return opts.validate ?? { ok: true, message: "fake provider", models, latencyMs: 1 };
    },

    async models(): Promise<ModelInfo[]> {
      return models.map((m) => ({ ...m }));
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts: RunnerOptions = {}): ModelRunner {
      this.runnersCreated++;
      return {
        async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
          const startedAt = now();
          let run: ReviewerRun;
          const completed = opts.delayMs ? await abortableDelay(opts.delayMs, signal) : !signal?.aborted;
          if (!completed) {
            run = buildRun(seat, input, { status: "timeout", output: null, error: "aborted" }, startedAt);
          } else {
            let result: ScriptResult;
            try {
              result = await script(seat, input);
            } catch (err: unknown) {
              result = err instanceof Error ? err : new Error(String(err));
            }
            run = buildRun(seat, input, result, startedAt);
          }
          if (run.audit.costUsd === undefined) run.audit = { ...run.audit, costUsd: fakeUsd(model, run.audit.tokens) };

          const usage: FakeCall["usage"] = [];
          if (hasTokens(run.audit.tokens)) {
            for (const d of splitUsage(run.audit.tokens, run.audit.costUsd ?? 0, opts.usageChunks ?? 2)) {
              usage.push(d);
              runnerOpts.onUsage?.(d);
            }
          }
          for (const path of run.audit.filesRead) {
            runnerOpts.onToolCall?.(
              { name: "read_file", input: { path } },
              { ok: true, output: `(fake contents of ${path})`, filesRead: [path] },
            );
          }
          calls.push({ seat, input, ws, connection: conn, model, run, usage });
          return run;
        },
      };
    },
  };
}
