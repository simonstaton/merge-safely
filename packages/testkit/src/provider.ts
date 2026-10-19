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
  ToolCall,
  ToolResult,
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
  /**
   * Simulated latency per run (real time), fixed or per seat. It races `seat.budget.deadlineMs` (status
   * "timeout" with partial usage) and the caller's abort signal (status "error" with partial usage).
   */
  delayMs?: number | ((seat: Seat, input: ReviewerInput) => number);
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
  /** Every tool event emitted to `onToolCall` (one per `audit.totalCalls`). */
  toolCalls: ToolCall[];
}

export interface FakeProvider extends ModelProvider {
  /** Every run, in completion order. */
  readonly calls: FakeCall[];
  /** Connections passed to `validate()`. */
  readonly validated: Connection[];
  /** Number of `createRunner()` calls. */
  readonly runnersCreated: number;
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

type RaceOutcome = { kind: "done" } | { kind: "deadline" } | { kind: "abort"; elapsedMs: number };

/** Wait `delayMs`, unless the seat deadline or the caller's abort comes first. */
function race(delayMs: number, deadlineMs: number, signal?: AbortSignal): Promise<RaceOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (o: RaceOutcome) => {
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const onAbort = () => finish({ kind: "abort", elapsedMs: Date.now() - t0 });
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => finish({ kind: "done" }), delayMs));
    if (deadlineMs > 0 && deadlineMs < delayMs) timers.push(setTimeout(() => finish({ kind: "deadline" }), deadlineMs));
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

/** The work a run did before it was cut off after `fraction` (0..1) of its simulated latency. */
function partialAudit(input: ReviewerInput, tokens: TokenUsage, fraction: number, wallMs: number): ToolUseAudit {
  const f = Math.min(1, Math.max(0, fraction));
  const full = passingAudit(input, tokens);
  return {
    substantiveCalls: Math.floor(full.substantiveCalls * f),
    totalCalls: Math.floor(full.totalCalls * f),
    filesRead: full.filesRead.slice(0, Math.floor(full.filesRead.length * f)),
    commandsRun: [],
    tokens: { in: Math.floor(tokens.in * f), out: Math.floor(tokens.out * f) },
    wallMs: Math.round(wallMs),
    turns: Math.floor(full.turns * f),
  };
}

/** Tool events consistent with the audit: reads for filesRead, searches up to substantiveCalls, list_dir after. */
function toolEvents(audit: ToolUseAudit): Array<[ToolCall, ToolResult]> {
  const out: Array<[ToolCall, ToolResult]> = [];
  for (let i = 0; i < audit.totalCalls; i++) {
    const path = audit.filesRead[i];
    if (path !== undefined && i < audit.substantiveCalls) {
      out.push([
        { id: `fake_${i}`, name: "read_file", input: { path } },
        { ok: true, output: `(fake contents of ${path})`, filesRead: [path] },
      ]);
    } else if (i < audit.substantiveCalls) {
      out.push([
        { id: `fake_${i}`, name: "search", input: { pattern: "TODO" } },
        { ok: true, output: "" },
      ]);
    } else {
      out.push([
        { id: `fake_${i}`, name: "list_dir", input: { path: "." } },
        { ok: true, output: "src/" },
      ]);
    }
  }
  return out;
}

/**
 * Give the run the shape a real runner would: judges carry `judgeOutput` (null on failure) and never a hunter
 * `output`; hunters never carry `judgeOutput`. Output of the wrong role is `schema-invalid`.
 */
function shapeForRole(seat: Seat, run: ReviewerRun): ReviewerRun {
  const r: ReviewerRun = { ...run };
  if (seat.role === "judge") {
    if (r.status === "ok" && r.judgeOutput == null) {
      r.status = "schema-invalid";
      r.error = r.output ? "judge seat returned a hunter review" : "judge seat returned no votes";
    }
    r.output = null;
    r.judgeOutput = r.judgeOutput ?? null;
  } else {
    if (r.status === "ok" && r.output === null) {
      r.status = "schema-invalid";
      r.error = r.judgeOutput ? "hunter seat returned judge votes" : "hunter seat returned no review";
    }
    delete r.judgeOutput;
  }
  return r;
}

/**
 * A scriptable ModelProvider. Each `run()` asks the script for the seat's result, fills the rest of the
 * `ReviewerRun` with defaults that pass attestation, enforces the seat deadline and `maxUsd` like the real
 * runners, streams usage through `onUsage`, emits tool events, and records the call.
 */
export function fakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const id = opts.id ?? "fake";
  const models = opts.models ?? [fakeModel({ provider: id })];
  const script = opts.script ?? defaultScript;
  const now = opts.now ?? (() => new Date());
  const tokens = opts.tokens ?? DEFAULT_TOKENS;
  const calls: FakeCall[] = [];
  const validated: Connection[] = [];
  let runnersCreated = 0;

  function skeleton(seat: Seat, input: ReviewerInput, audit: ToolUseAudit, startedAt: Date): ReviewerRun {
    return {
      seat,
      headSha: input.change.headSha,
      round: input.round,
      output: null,
      audit,
      status: "ok",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + audit.wallMs).toISOString(),
    };
  }

  function fromScript(seat: Seat, input: ReviewerInput, result: ScriptResult, startedAt: Date): ReviewerRun {
    if (result instanceof Error) {
      // Failed before doing any work: nothing read, nothing spent.
      const audit = partialAudit(input, tokens, 0, 0);
      return { ...skeleton(seat, input, audit, startedAt), status: "error", error: result.message };
    }
    if (isJudgeOutput(result))
      return { ...skeleton(seat, input, passingAudit(input, tokens), startedAt), judgeOutput: result };
    if (isReviewerOutput(result))
      return { ...skeleton(seat, input, passingAudit(input, tokens), startedAt), output: result };
    // Partial run: merge over the defaults (audit merged field by field).
    const audit = { ...passingAudit(input, tokens), ...(result.audit ?? {}) };
    const merged: ReviewerRun = { ...skeleton(seat, input, audit, startedAt), ...result, audit };
    if (result.startedAt && !result.finishedAt) {
      merged.finishedAt = new Date(Date.parse(result.startedAt) + audit.wallMs).toISOString();
    }
    if (!("output" in result) && !("judgeOutput" in result) && merged.status === "ok") {
      if (seat.role === "judge") merged.judgeOutput = confirmAll(input.candidateFindings);
      else merged.output = passOutput();
    }
    return merged;
  }

  async function execute(seat: Seat, input: ReviewerInput, signal?: AbortSignal): Promise<ReviewerRun> {
    const startedAt = now();
    if (signal?.aborted) {
      return {
        ...skeleton(seat, input, partialAudit(input, tokens, 0, 0), startedAt),
        status: "error",
        error: "run aborted by caller",
      };
    }
    const delay = typeof opts.delayMs === "function" ? opts.delayMs(seat, input) : (opts.delayMs ?? 0);
    if (delay > 0) {
      const outcome = await race(delay, seat.budget.deadlineMs, signal);
      if (outcome.kind === "deadline") {
        const d = seat.budget.deadlineMs;
        return {
          ...skeleton(seat, input, partialAudit(input, tokens, d / delay, d), startedAt),
          status: "timeout",
          error: `seat deadline of ${d}ms exceeded`,
        };
      }
      if (outcome.kind === "abort") {
        const e = outcome.elapsedMs;
        return {
          ...skeleton(seat, input, partialAudit(input, tokens, e / delay, e), startedAt),
          status: "error",
          error: "run aborted by caller",
        };
      }
    }
    let result: ScriptResult;
    try {
      result = await script(seat, input);
    } catch (err: unknown) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    return fromScript(seat, input, result, startedAt);
  }

  const provider: FakeProvider = {
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
    get runnersCreated() {
      return runnersCreated;
    },

    reset: () => {
      calls.length = 0;
      validated.length = 0;
      runnersCreated = 0;
    },

    validate: async (conn: Connection): Promise<ValidationResult> => {
      validated.push(conn);
      if (typeof opts.validate === "function") return opts.validate(conn);
      return opts.validate ?? { ok: true, message: "fake provider", models, latencyMs: 1 };
    },

    models: async (): Promise<ModelInfo[]> => models.map((m) => ({ ...m })),

    createRunner: (conn: Connection, model: ModelInfo, runnerOpts: RunnerOptions = {}): ModelRunner => {
      runnersCreated++;
      const run = async (
        seat: Seat,
        input: ReviewerInput,
        ws: WorkspaceHandle,
        signal?: AbortSignal,
      ): Promise<ReviewerRun> => {
        let r = shapeForRole(seat, await execute(seat, input, signal));
        if (r.audit.costUsd === undefined) r.audit = { ...r.audit, costUsd: fakeUsd(model, r.audit.tokens) };
        const maxUsd = seat.budget.maxUsd;
        if (r.status === "ok" && maxUsd !== undefined && (r.audit.costUsd ?? 0) > maxUsd) {
          r = {
            ...r,
            status: "budget-exceeded",
            output: null,
            ...(seat.role === "judge" ? { judgeOutput: null } : {}),
            error: `seat budget of $${maxUsd} exceeded ($${(r.audit.costUsd ?? 0).toFixed(4)})`,
          };
        }

        const usage: FakeCall["usage"] = [];
        if (hasTokens(r.audit.tokens)) {
          for (const d of splitUsage(r.audit.tokens, r.audit.costUsd ?? 0, opts.usageChunks ?? 2)) {
            usage.push(d);
            runnerOpts.onUsage?.(d);
          }
        }
        const toolCalls: ToolCall[] = [];
        for (const [call, result] of toolEvents(r.audit)) {
          toolCalls.push(call);
          runnerOpts.onToolCall?.(call, result);
        }
        calls.push({ seat, input, ws, connection: conn, model, run: r, usage, toolCalls });
        return r;
      };
      return { run };
    },
  };
  return provider;
}
