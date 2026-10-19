/**
 * Running one seat: workspace, prompt, runner, deadline, streamed cost rows, provider fallback. A seat never throws:
 * every failure becomes a ReviewerRun with status "error" (or "timeout") so the panel degrades instead of crashing,
 * and the workspace is always disposed.
 */
import { planFallback } from "../panel/seating.js";
import type { ToolExecutor, ToolExecutorFactory, WorkspaceHandle } from "../ports.js";
import { JUDGE_OUTPUT_JSON_SCHEMA, REVIEWER_OUTPUT_JSON_SCHEMA } from "../schema/reviewer-output.js";
import { assignFingerprints } from "../stages/fingerprint.js";
import { redactFinding, redactText } from "../stages/intake.js";
import type {
  Change,
  CostEntry,
  Finding,
  ModelInfo,
  ModelRef,
  ReviewerInput,
  ReviewerRun,
  RunStatus,
  Seat,
  Tier,
  TokenUsage,
  ToolUseAudit,
  UntrustedText,
} from "../types.js";
import { catalogOf, type Env, emit, modelInfoFor, nowIso, safeText, sleep, withTimeout } from "./env.js";
import type { PromptBuildOptions } from "./types.js";
import { addUsage } from "./util.js";

/** Everything a seat in this round shares. */
export interface RoundContext {
  change: Change;
  tier: Tier;
  round: number;
  diff: string;
  diffIsDelta: boolean;
  sinceSha?: string;
  untrusted: UntrustedText;
  knownFindings: Finding[];
  /** Scope key for ledger rows and installation ceilings. */
  scopeId: string;
  /** Local mode: a dirty working tree is acceptable (see `workspaceProblem`). */
  allowDirty: boolean;
  /** Whether the verdict will be stored. */
  persist: boolean;
  /** Admission for a fallback attempt; omitted = always admissible. */
  fallbackFits?: (original: Seat, fallback: Seat, spentUsd: number) => boolean;
}

/** The headSha a workspace reports for an uncommitted working tree. */
export const WORKTREE = "WORKTREE";

/**
 * Why a workspace cannot be reviewed for this round, or undefined when it can. PR mode needs a clean checkout of
 * exactly the pinned SHA. Local mode allows a dirty tree, but a dirty tree is never stored under a real commit SHA.
 */
export function workspaceProblem(ws: WorkspaceHandle, rc: RoundContext): string | undefined {
  const pinned = rc.change.headSha;
  const dirty = ws.dirty === true || ws.headSha === WORKTREE;
  if (!rc.allowDirty) {
    if (dirty)
      return "workspace has uncommitted changes; a pull request review needs a clean checkout of the pinned commit";
    if (ws.headSha !== pinned) {
      return `workspace checked out ${ws.headSha.slice(0, 12)}, not the pinned head ${pinned.slice(0, 12)}`;
    }
    return undefined;
  }
  if (ws.headSha !== pinned && ws.headSha !== WORKTREE) {
    return `workspace checked out ${ws.headSha.slice(0, 12)}, not the pinned head ${pinned.slice(0, 12)}`;
  }
  if (dirty && rc.persist && pinned !== WORKTREE) {
    return `a dirty working tree cannot be stored under commit ${pinned.slice(0, 12)}; pass headSha "${WORKTREE}" or persist: false`;
  }
  return undefined;
}

export interface SeatOutcome {
  run: ReviewerRun;
  /** Spend across every attempt (a failed primary attempt has still been paid for). */
  usd: number;
  tokens: TokenUsage;
}

/** Extra time a runner gets after the abort signal before the orchestrator stops waiting for it. */
export const DEADLINE_GRACE_MS = 5_000;

const ZERO_USAGE: TokenUsage = { in: 0, out: 0 };

function emptyAudit(): ToolUseAudit {
  return {
    substantiveCalls: 0,
    totalCalls: 0,
    filesRead: [],
    commandsRun: [],
    tokens: { ...ZERO_USAGE },
    wallMs: 0,
    turns: 0,
  };
}

function failedRun(
  env: Env,
  seat: Seat,
  rc: RoundContext,
  status: RunStatus,
  error: string,
  startedAt: string,
): ReviewerRun {
  const run: ReviewerRun = {
    seat,
    headSha: rc.change.headSha,
    round: rc.round,
    output: null,
    audit: emptyAudit(),
    status,
    error,
    startedAt,
    finishedAt: nowIso(env),
  };
  if (seat.role === "judge") run.judgeOutput = null;
  return run;
}

/** The ReviewerInput minus the prompt, as the prompt builders and runner see it. */
export function buildInput(
  env: Env,
  rc: RoundContext,
  seat: Seat,
  candidates?: Finding[],
): Omit<ReviewerInput, "prompt"> {
  const input: Omit<ReviewerInput, "prompt"> = {
    change: rc.change,
    tier: rc.tier,
    round: rc.round,
    diff: rc.diff,
    diffIsDelta: rc.diffIsDelta,
    untrusted: rc.untrusted,
    knownFindings: rc.knownFindings,
    allowedCommands: [...env.policy.runner.allowedCommands],
    outputSchema: seat.role === "judge" ? JUDGE_OUTPUT_JSON_SCHEMA : REVIEWER_OUTPUT_JSON_SCHEMA,
  };
  if (seat.role === "judge") input.candidateFindings = candidates ?? [];
  return input;
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** A trusted description of the tools the runner will expose, built from the executor's own definitions. */
export function describeTools(executor: ToolExecutor): string | undefined {
  const defs = executor.definitions();
  if (defs.length === 0) return undefined;
  return [
    "Read-only tools over a checkout of the head commit (the runner records every call as proof of work):",
    ...defs.map((d) => `- ${d.name}: ${firstSentence(d.description)}`),
  ].join("\n");
}

/** Normalise a runner's result: pin seat/sha/round, make sure an audit exists, scrub the error text. */
function normaliseRun(env: Env, raw: ReviewerRun, seat: Seat, rc: RoundContext, startedAt: string): ReviewerRun {
  const run: ReviewerRun = {
    ...raw,
    seat,
    headSha: rc.change.headSha,
    round: rc.round,
    output: raw.output ?? null,
    audit: raw.audit ?? emptyAudit(),
    startedAt: raw.startedAt ?? startedAt,
    finishedAt: raw.finishedAt ?? nowIso(env),
  };
  if (raw.error !== undefined) run.error = safeText(env, raw.error, 500);
  return run;
}

/**
 * Core-owned finding ids and redaction: every finding a model wrote (hunter findings, judge new findings) gets a
 * fingerprint and has secret shapes redacted; hunter findings are tagged with the seat's lens.
 */
export function sanitiseRun(run: ReviewerRun): ReviewerRun {
  const out: ReviewerRun = { ...run };
  if (run.output) {
    const findings = assignFingerprints(run.output.findings).map((f) =>
      redactFinding({ ...f, lenses: [...new Set([...(f.lenses ?? []), run.seat.lens])] }),
    );
    out.output = { ...run.output, summary: redactText(run.output.summary), findings };
    if (run.output.confidenceRefuted) out.output.confidenceRefuted = run.output.confidenceRefuted.map(redactText);
  }
  if (run.judgeOutput) {
    out.judgeOutput = {
      ...run.judgeOutput,
      votes: run.judgeOutput.votes.map((v) => (v.reason === undefined ? v : { ...v, reason: redactText(v.reason) })),
    };
    if (run.judgeOutput.newFindings) {
      out.judgeOutput.newFindings = assignFingerprints(run.judgeOutput.newFindings).map((f) => redactFinding(f));
    }
    if (run.judgeOutput.summary !== undefined) out.judgeOutput.summary = redactText(run.judgeOutput.summary);
  }
  return out;
}

interface Attempt {
  run: ReviewerRun;
  usd: number;
  tokens: TokenUsage;
}

/**
 * Wait for outstanding ledger appends (including ones a late runner pushes while we wait), bounded overall by the
 * ledger append timeout. Each append is already individually bounded and never rejects.
 */
async function drain(env: Env, appends: Promise<void>[]): Promise<void> {
  const until = Date.now() + env.timeouts.ledgerAppendMs;
  let seen = 0;
  while (seen < appends.length) {
    const left = until - Date.now();
    if (left <= 0) {
      env.logger.warn("cost ledger writes still pending after the drain timeout; continuing", {
        pending: appends.length - seen,
      });
      return;
    }
    const batch = appends.slice(seen);
    seen = appends.length;
    await Promise.race([Promise.all(batch), sleep(left)]);
  }
}

/**
 * Run one seat. `workspaceSeatId` distinguishes reruns (second judge round) in workspace and logs; the seat id in
 * ledger rows and on the run stays the seat's own.
 */
export async function runSeat(
  env: Env,
  rc: RoundContext,
  seat: Seat,
  opts: { candidates?: Finding[]; workspaceSeatId?: string } = {},
): Promise<SeatOutcome> {
  const startedAt = nowIso(env);
  const startedMs = env.clock.now().getTime();
  const appends: Promise<void>[] = [];
  let ws: WorkspaceHandle | undefined;
  try {
    let acquired: WorkspaceHandle;
    try {
      acquired = await withTimeout(
        Promise.resolve().then(() =>
          env.deps.workspace.acquire(rc.change, { seatId: opts.workspaceSeatId ?? seat.id }),
        ),
        env.timeouts.workspaceAcquireMs,
        "workspace acquire",
      );
    } catch (err: unknown) {
      const run = failedRun(env, seat, rc, "error", `workspace unavailable: ${safeText(env, err, 300)}`, startedAt);
      return { run, usd: 0, tokens: { ...ZERO_USAGE } };
    }
    ws = acquired;
    const problem = workspaceProblem(acquired, rc);
    if (problem) {
      env.logger.error("workspace rejected", { seatId: seat.id, reason: problem });
      return { run: failedRun(env, seat, rc, "error", problem, startedAt), usd: 0, tokens: { ...ZERO_USAGE } };
    }
    const first = await attempt(env, rc, seat, seat, acquired, opts.candidates, appends);
    if (first.run.status !== "error") return first;
    const fallbackSeat = planFallbackSeat(env, rc, seat, first.usd, env.clock.now().getTime() - startedMs);
    if (!fallbackSeat) return first;
    const fallback = fallbackSeat.model;
    env.logger.warn("seat failed; retrying on fallback model", {
      seatId: seat.id,
      from: `${seat.model.connectionId}/${seat.model.name}`,
      to: `${fallback.connectionId}/${fallback.name}`,
    });
    emit(env, "merge_safely.seat.fallback", 1, "count", { seat: seat.id, connection: fallback.connectionId });
    const second = await attempt(env, rc, seat, fallbackSeat, acquired, opts.candidates, appends);
    return {
      run: { ...second.run, fallbackUsed: fallback },
      usd: first.usd + second.usd,
      tokens: addUsage(first.tokens, second.tokens),
    };
  } catch (err: unknown) {
    // Defensive: attempt() never throws, but a seat must never take the review down.
    const run = failedRun(env, seat, rc, "error", safeText(env, err, 300), startedAt);
    return { run, usd: 0, tokens: { ...ZERO_USAGE } };
  } finally {
    // attempt() only returns once the runner settled or its grace after the deadline elapsed.
    if (ws) {
      const handle = ws;
      try {
        await withTimeout(
          Promise.resolve().then(() => handle.dispose()),
          env.timeouts.workspaceDisposeMs,
          "workspace dispose",
        );
      } catch (err: unknown) {
        env.logger.warn("workspace dispose failed", { seatId: seat.id, error: safeText(env, err) });
      }
    }
    await drain(env, appends);
  }
}

/**
 * The fallback seat for a failed attempt: policy.models.fallback with whatever per-seat budget remains (maxUsd minus
 * the first attempt's spend, and the remaining deadline). Undefined when there is no reachable fallback, nothing is
 * left of the seat budget, or the fallback's estimate would breach the per-change ceiling.
 */
function planFallbackSeat(
  env: Env,
  rc: RoundContext,
  seat: Seat,
  spentUsd: number,
  elapsedMs: number,
): Seat | undefined {
  let fallback: ModelRef | undefined;
  try {
    fallback = planFallback(seat, env.policy, env.deps.connections, (id) => catalogOf(env, id), {
      normalise: env.normalise,
    });
  } catch (err: unknown) {
    env.logger.warn("fallback planning failed", { seatId: seat.id, error: safeText(env, err) });
    return undefined;
  }
  if (!fallback) return undefined;
  const deadlineMs = seat.budget.deadlineMs - elapsedMs;
  if (deadlineMs <= 0) {
    env.logger.warn("no fallback: the seat deadline is used up", { seatId: seat.id });
    return undefined;
  }
  const budget = { ...seat.budget, deadlineMs };
  if (seat.budget.maxUsd !== undefined) {
    const left = seat.budget.maxUsd - spentUsd;
    if (left <= 0) {
      env.logger.warn("no fallback: the seat's per-seat budget is spent", { seatId: seat.id });
      return undefined;
    }
    budget.maxUsd = left;
  }
  const fallbackSeat: Seat = { ...seat, model: fallback, budget };
  if (rc.fallbackFits && !rc.fallbackFits(seat, fallbackSeat, spentUsd)) {
    env.logger.warn("no fallback: its estimate would breach budget.perChangeUsd", { seatId: seat.id });
    return undefined;
  }
  return fallbackSeat;
}

async function attempt(
  env: Env,
  rc: RoundContext,
  seat: Seat,
  runAs: Seat,
  ws: WorkspaceHandle,
  candidates: Finding[] | undefined,
  appends: Promise<void>[],
): Promise<Attempt> {
  const startedAt = nowIso(env);
  const model = runAs.model;
  const observed = { usd: 0, tokens: { ...ZERO_USAGE } as TokenUsage };
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  try {
    const conn = env.deps.connections.find((c) => c.id === model.connectionId);
    if (!conn) throw new Error(`connection "${model.connectionId}" is not available to this gate`);
    const info: ModelInfo = modelInfoFor(env, model);
    const rp = env.policy.runner;
    const tools: ToolExecutorFactory = (w, o) =>
      env.deps.tools(w, {
        allowedCommands: [...rp.allowedCommands],
        maxOutputBytes: rp.maxToolOutputBytes,
        commandTimeoutMs: rp.commandTimeoutMs,
        ...(o ?? {}),
      });
    const input = buildInput(env, rc, seat, candidates);
    const popts: PromptBuildOptions = { maxRounds: env.policy.rounds.max };
    if (seat.persona !== undefined) popts.persona = seat.persona;
    if (rc.diffIsDelta && rc.sinceSha) popts.deltaSinceSha = rc.sinceSha;
    const toolsDescription = describeTools(tools(ws));
    if (toolsDescription) popts.toolsDescription = toolsDescription;
    const prompt =
      seat.role === "judge" ? env.deps.prompts.judge(input, popts) : env.deps.prompts.hunter(seat.lens, input, popts);

    const onUsage = (delta: { tokens: TokenUsage; usd?: number }): void => {
      try {
        const tokens: TokenUsage = { ...delta.tokens };
        let usd: number;
        let estimated: boolean;
        if (typeof delta.usd === "number" && Number.isFinite(delta.usd)) {
          usd = Math.max(0, delta.usd);
          estimated = false;
        } else {
          const p = env.deps.pricing.price(info, tokens);
          usd = p.usd;
          estimated = p.estimated;
        }
        observed.usd += usd;
        observed.tokens = addUsage(observed.tokens, tokens);
        const ledger = env.deps.ledger;
        if (ledger) {
          const entry: CostEntry = {
            at: nowIso(env),
            repo: rc.change.repo,
            number: rc.change.number,
            headSha: rc.change.headSha,
            round: rc.round,
            seatId: seat.id,
            lens: seat.lens,
            connectionId: model.connectionId,
            provider: model.provider,
            model: model.name,
            tokens,
            usd,
            estimated,
            installationId: rc.scopeId,
          };
          appends.push(
            withTimeout(
              Promise.resolve().then(() => ledger.append(entry)),
              env.timeouts.ledgerAppendMs,
              "cost ledger append",
            ).catch((err: unknown) => {
              env.logger.error("cost ledger append failed", { seatId: seat.id, error: safeText(env, err) });
            }),
          );
        }
        const tags = { connection: model.connectionId, provider: model.provider, model: model.name, lens: seat.lens };
        emit(env, "merge_safely.seat.usage_usd", usd, "usd", tags);
        emit(env, "merge_safely.seat.usage_tokens", tokens.in + tokens.out, "tokens", tags);
      } catch (err: unknown) {
        env.logger.warn("usage accounting failed", { seatId: seat.id, error: safeText(env, err) });
      }
    };

    const provider = env.deps.providers(conn);
    const runner = provider.createRunner(conn, info, { tools, onUsage, logger: env.logger });
    const ac = new AbortController();
    const deadline = Math.max(1, runAs.budget.deadlineMs);
    timers.push(setTimeout(() => ac.abort(), deadline));
    const hard = new Promise<"timeout">((resolve) => {
      timers.push(setTimeout(() => resolve("timeout"), deadline + DEADLINE_GRACE_MS));
    });
    const result = await Promise.race([runner.run(runAs, { ...input, prompt }, ws, ac.signal), hard]);
    if (result === "timeout") {
      const run = failedRun(
        env,
        seat,
        rc,
        "timeout",
        `seat exceeded its ${Math.round(deadline / 1000)}s deadline`,
        startedAt,
      );
      return { run, usd: observed.usd, tokens: observed.tokens };
    }
    const run = normaliseRun(env, result, seat, rc, startedAt);
    if (run.audit.costUsd === undefined && observed.usd > 0) run.audit = { ...run.audit, costUsd: observed.usd };
    const auditTokens = run.audit.tokens.in + run.audit.tokens.out > 0 ? run.audit.tokens : observed.tokens;
    return { run, usd: run.audit.costUsd ?? observed.usd, tokens: auditTokens };
  } catch (err: unknown) {
    const run = failedRun(env, seat, rc, "error", safeText(env, err, 300), startedAt);
    return { run, usd: observed.usd, tokens: observed.tokens };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
