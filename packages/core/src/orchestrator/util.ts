import { redactText } from "../stages/intake.js";
import type { Change, Connection, Seat, TokenUsage } from "../types.js";
import type { UsageEstimateContext } from "./types.js";

/**
 * Conservative per-seat token estimate for budgets and `estimate()`. Real cost comes from the streamed ledger; this
 * only has to be in the right order of magnitude and err high.
 *
 *   context = 6k (system prompt, rubric, metadata) + diffChars / 4
 *   in      = context * 4 (an agentic loop resends context; caching is ignored) + 3k per expected turn of tool output
 *   out     = 6k hunters, 4k judges
 * Expected turns are min(maxTurns, 12). Judges cost 1.5x when a second judge round may run.
 */
export function estimateSeatUsage(seat: Seat, ctx: UsageEstimateContext): TokenUsage {
  const context = 6_000 + Math.ceil(Math.max(0, ctx.diffChars) / 4);
  const turns = Math.min(Math.max(1, seat.budget.maxTurns), 12);
  let input = context * 4 + 3_000 * turns;
  let out = seat.role === "judge" ? 4_000 : 6_000;
  if (seat.role === "judge" && ctx.secondJudgeRound) {
    input = Math.ceil(input * 1.5);
    out = Math.ceil(out * 1.5);
  }
  return { in: input, out };
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
