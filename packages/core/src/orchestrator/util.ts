import { redactText } from "../stages/intake.js";
import type { Change, Connection, Seat, TokenUsage } from "../types.js";
import type { UsageEstimateContext } from "./types.js";

/** Fixed prompt overhead per seat: system prompt, rubric, metadata, untrusted blocks. */
export const SYSTEM_TOKENS = 6_000;
/** Tool output the reviewer reads per turn (files, grep hits, git output). */
export const TOOL_READ_TOKENS_PER_TURN = 3_000;
/** Turns a seat is expected to use (bounded by its maxTurns). */
export const EXPECTED_TURNS = 12;

/** Diff tokens from chars (~4 chars per token). */
export const diffTokens = (diffChars: number): number => Math.ceil(Math.max(0, diffChars) / 4);

/**
 * Conservative per-seat token estimate for budgets and `estimate()`. Real cost comes from the streamed ledger; this
 * errs high. Caching is assumed absent, because not every provider has it.
 *
 *   turns   = min(maxTurns, 12)
 *   context = 6k (system) + diffChars / 4 + 3k * turns (tool reads), capped at the model's contextTokens
 *   in      = context * max(1, turns / 3)   (an agentic loop resends a growing context every turn)
 *   out     = 6k hunters, 4k judges; both scaled by 1.5 for judges when a second judge round may run
 */
export function estimateSeatUsage(seat: Seat, ctx: UsageEstimateContext): TokenUsage {
  const turns = Math.min(Math.max(1, seat.budget.maxTurns), EXPECTED_TURNS);
  let context = SYSTEM_TOKENS + diffTokens(ctx.diffChars) + TOOL_READ_TOKENS_PER_TURN * turns;
  if (ctx.contextTokens !== undefined && ctx.contextTokens > 0) context = Math.min(context, ctx.contextTokens);
  let input = Math.ceil(context * Math.max(1, turns / 3));
  let out = seat.role === "judge" ? 4_000 : 6_000;
  if (seat.role === "judge" && ctx.secondJudgeRound) {
    input = Math.ceil(input * 1.5);
    out = Math.ceil(out * 1.5);
  }
  return { in: input, out };
}

/** True when the diff alone cannot fit the model's context window (contextTokens 0/undefined = unknown, never). */
export function diffExceedsContext(diffChars: number, contextTokens: number | undefined): boolean {
  return contextTokens !== undefined && contextTokens > 0 && SYSTEM_TOKENS + diffTokens(diffChars) > contextTokens;
}

/** Approximate unified-diff size from change stats, for estimates made before the diff is fetched. */
export function estimateDiffChars(change: Change): number {
  return (
    (change.stats.additions + change.stats.deletions) * 60 + Math.max(change.stats.files, change.files.length) * 150
  );
}

/** Every secret value carried by the connections, for scrubbing error text. */
export function connectionSecrets(connections: Connection[]): string[] {
  const out: string[] = [];
  for (const c of connections) {
    const s = c.secret;
    switch (s.kind) {
      case "api-key":
        out.push(s.apiKey);
        break;
      case "openai-compatible":
        if (s.apiKey) out.push(s.apiKey);
        for (const v of Object.values(s.headers ?? {})) out.push(v);
        break;
      case "anthropic-compatible":
        out.push(s.apiKey);
        for (const v of Object.values(s.headers ?? {})) out.push(v);
        break;
      case "oauth":
        out.push(s.accessToken);
        if (s.refreshToken) out.push(s.refreshToken);
        break;
      case "cloud":
        if (s.credentialsRef) out.push(s.credentialsRef);
        break;
      case "subscription":
        if (s.credentialFileRef) out.push(s.credentialFileRef);
        break;
    }
  }
  return [...new Set(out.filter((v) => typeof v === "string" && v.length >= 4))].sort((a, b) => b.length - a.length);
}

/** Error text safe for events, logs and GateError messages: known secrets removed, secret shapes redacted, clipped. */
export function scrub(text: string, secrets: readonly string[], max = 1_000): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  out = redactText(out);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown error";
}

export const NOOP_LOGGER = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { in: a.in + b.in, out: a.out + b.out };
  const cachedIn = (a.cachedIn ?? 0) + (b.cachedIn ?? 0);
  const cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  if (cachedIn > 0) out.cachedIn = cachedIn;
  if (cacheWrite > 0) out.cacheWrite = cacheWrite;
  return out;
}
