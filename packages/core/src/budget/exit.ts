/**
 * Runner exit classification: a budget stop is a pause, not a crash (design 7.6).
 *
 * A model process that hits its own budget flag exits non-zero, which looks identical to a crash on the wire.
 * Using only signals the runner already has (budget flag set, usage near a cap, no stack-trace-looking stderr) the
 * exit is classified as "budget-exceeded" with recovery text, never "error".
 */
import type { RunStatus } from "../types.js";

export interface RunnerExitInput {
  exitCode: number | null;
  signal?: string | null;
  stderr: string;
  /** True when the runner passed a budget/turn cap flag to the process. */
  budgetFlagSet: boolean;
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

/** Usage at or above this fraction of a cap counts as "at the cap" (caps are checked between turns, so runs stop short). */
const NEAR_CAP = 0.9;

const STACK_PATTERNS: RegExp[] = [
  /^\s+at\s+.+[(\s].*:\d+(:\d+)?\)?\s*$/m, // JS/Java stack frame
  /Traceback \(most recent call last\)/, // Python
  /^panic:/m, // Go
  /^goroutine \d+ \[/m,
  /Segmentation fault|core dumped/i,
  /FATAL ERROR:/, // V8 OOM etc.
  /Unhandled(Promise)?Rejection|uncaught exception/i,
  /^\s*thread '.*' panicked at/m, // Rust
];

export function looksLikeStackTrace(stderr: string): boolean {
  return STACK_PATTERNS.some((re) => re.test(stderr));
}

function near(value: number | undefined, cap: number | undefined): boolean {
  return value !== undefined && cap !== undefined && cap > 0 && value >= cap * NEAR_CAP;
}

export function classifyRunnerExit(input: RunnerExitInput): RunnerExitClass {
  const { caps, usage } = input;
  const deadlineHit = caps.deadlineMs !== undefined && caps.deadlineMs > 0 && input.wallMs >= caps.deadlineMs;

  if (input.timedOut || (deadlineHit && input.exitCode !== 0)) {
    return {
      status: "timeout",
      reason: `Seat exceeded its deadline after ${Math.round(input.wallMs / 1000)}s.`,
      recovery: "Raise budget.seatDeadlineMs and re-run the check.",
    };
  }

  if (input.exitCode === 0 && !input.signal) return { status: "ok", reason: "Runner exited cleanly." };

  const usdCap = near(usage?.usd, caps.maxUsd);
  const turnCap = near(usage?.turns, caps.maxTurns);
  if (input.budgetFlagSet && (usdCap || turnCap) && !looksLikeStackTrace(input.stderr)) {
    const which = usdCap
      ? `$${(usage?.usd ?? 0).toFixed(2)} of its $${(caps.maxUsd ?? 0).toFixed(2)} cap`
      : `${usage?.turns ?? 0} of its ${caps.maxTurns ?? 0} turn cap`;
    return {
      status: "budget-exceeded",
      reason: `Seat stopped at its budget cap (${which}). This is a pause, not a crash.`,
      recovery: usdCap
        ? "Raise budget.perSeatUsd and re-run the check."
        : "Raise budget.seatMaxTurns and re-run the check.",
    };
  }

  const how = input.signal ? `signal ${input.signal}` : `exit code ${input.exitCode ?? "null"}`;
  // stderr is deliberately not echoed: it may carry secrets, and reasons reach digests and logs.
  return { status: "error", reason: `Runner failed with ${how}.` };
}
