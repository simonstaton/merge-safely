/**
 * Runner exit classification: a budget stop is a pause, not a crash (design 7.6).
 *
 * A model process that hits its own budget flag exits non-zero, which looks identical to a crash on the wire.
 * This classifier is deliberately conservative; when in doubt the answer is "error". "budget-exceeded" requires
 * ALL of:
 *   - the process exited (no signal) with a non-zero code,
 *   - the runner set the budget flag,
 *   - evidence the cap was hit: turns >= maxTurns, or usd >= 95% of maxUsd, or an explicit `budgetSubtype` reported
 *     by the runner (e.g. a CLI result subtype such as "error_max_turns" / "error_max_budget_usd"),
 *   - stderr carries no failure markers: no HTTP 4xx/5xx status, no "error:"/"Error"/exception text, and no stack
 *     frames (including ESM `at file://…` and `at fn (…)` frames).
 * A signal-terminated process is "timeout" when the runner timed it out, else "error" (e.g. an OOM SIGKILL).
 */
import type { RunStatus } from "../types.js";

export interface RunnerExitInput {
  exitCode: number | null;
  signal?: string | null;
  stderr: string;
  /** True when the runner passed a budget/turn cap flag to the process. */
  budgetFlagSet: boolean;
  /** Explicit budget-stop reason observed by the runner (e.g. a CLI result subtype). Strongest evidence. */
  budgetSubtype?: string;
  usage?: { usd?: number; turns?: number };
  caps: { maxUsd?: number; maxTurns?: number; deadlineMs?: number };
  wallMs: number;
  timedOut?: boolean;
}

export interface RunnerExitClass {
  status: RunStatus;
  reason: string;
  recovery?: string;
}

const USD_NEAR_CAP = 0.95;

const FAILURE_PATTERNS: RegExp[] = [
  /\b[45]\d{2}\b/, // HTTP status (429 rate limit, 401 auth, 500 …)
  /error:/i,
  /\bError\b/,
  /exception/i,
  /^\s*at\s+(?:async\s+)?\S+\s+\(.*\)\s*$/m, // at fn (file:line:col)
  /^\s*at\s+(?:file|node):\/\//m, // ESM / node: frames
  /^\s*at\s+\/\S+:\d+/m, // at /abs/path.js:1:2
  /Traceback \(most recent call last\)/, // Python
  /^panic:/m, // Go
  /^goroutine \d+ \[/m,
  /Segmentation fault|core dumped/i,
  /FATAL/,
  /Unhandled(Promise)?Rejection|uncaught/i,
  /panicked at/, // Rust
];

/** True when stderr shows any sign of a real failure (status codes, error text, stack frames). */
export function looksLikeFailure(stderr: string): boolean {
  return FAILURE_PATTERNS.some((re) => re.test(stderr));
}

export function classifyRunnerExit(input: RunnerExitInput): RunnerExitClass {
  const { caps, usage } = input;

  if (input.timedOut) {
    return {
      status: "timeout",
      reason: `Seat exceeded its deadline after ${Math.round(input.wallMs / 1000)}s.`,
      recovery: "Raise budget.seatDeadlineMs and re-run the check.",
    };
  }

  if (input.signal) {
    return { status: "error", reason: `Runner was terminated by signal ${input.signal}.` };
  }

  if (input.exitCode === 0) return { status: "ok", reason: "Runner exited cleanly." };

  const turnsHit =
    usage?.turns !== undefined && caps.maxTurns !== undefined && caps.maxTurns > 0 && usage.turns >= caps.maxTurns;
  const usdHit =
    usage?.usd !== undefined && caps.maxUsd !== undefined && caps.maxUsd > 0 && usage.usd >= caps.maxUsd * USD_NEAR_CAP;
  const subtype = input.budgetSubtype?.trim();
  const evidence = turnsHit || usdHit || (subtype !== undefined && subtype.length > 0);

  if (input.budgetFlagSet && evidence && !looksLikeFailure(input.stderr)) {
    const turnStop = turnsHit || (!usdHit && subtype !== undefined && /turn/i.test(subtype));
    const which = turnStop
      ? `${usage?.turns ?? "?"} of ${caps.maxTurns ?? "?"} turns`
      : usdHit
        ? `$${(usage?.usd ?? 0).toFixed(2)} of its $${(caps.maxUsd ?? 0).toFixed(2)} cap`
        : `runner reported "${subtype}"`;
    return {
      status: "budget-exceeded",
      reason: `Seat stopped at its budget cap (${which}). This is a pause, not a crash.`,
      recovery: turnStop
        ? "Raise budget.seatMaxTurns and re-run the check."
        : "Raise budget.perSeatUsd and re-run the check.",
    };
  }

  // stderr is deliberately not echoed: it may carry secrets, and reasons reach digests and logs.
  return { status: "error", reason: `Runner failed with exit code ${input.exitCode ?? "null"}.` };
}
