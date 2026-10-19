import type { RunStatus } from "@merge-safely/core";

/**
 * Exit classification shared by both runners (design 7.6, "a budget stop is a pause, not a crash").
 * A budget stop is reported as budget-exceeded with recovery text, never as a generic error.
 */
export interface ExitSignals {
  /** The runner's own deadline fired. */
  timedOut?: boolean;
  deadlineMs?: number;
  /** The caller's AbortSignal fired. */
  aborted?: boolean;
  /** Which budget the runner (or the model process) stopped on, when known. */
  budgetHit?: "turns" | "usd";
  maxTurns?: number;
  maxUsd?: number;
  usd?: number;
  /** CLI only. */
  exitCode?: number | null;
  /** CLI result subtype, e.g. "success", "error_max_turns", "error_max_budget_usd". */
  subtype?: string;
  isError?: boolean;
  /** Safe (already scrubbed) error detail, e.g. the last stderr line. */
  detail?: string;
}

export interface ExitClass {
  status: RunStatus;
  error?: string;
}

export const RECOVERY_TURNS =
  "Recovery: raise the seat's maxTurns in policy (or narrow the change), then re-run the check. This is a budget stop, not a crash.";
export const RECOVERY_USD =
  "Recovery: raise the per-seat USD ceiling (perSeatUsd / maxUsd) in policy, then re-run the check. This is a budget stop, not a crash.";

function budgetFromSubtype(subtype: string | undefined): "turns" | "usd" | undefined {
  if (!subtype) return undefined;
  if (/max_turns/.test(subtype)) return "turns";
  if (/budget|max_cost|usd/.test(subtype)) return "usd";
  return undefined;
}

export function classifyExit(s: ExitSignals): ExitClass {
  if (s.timedOut) {
    return { status: "timeout", error: `seat deadline reached${s.deadlineMs ? ` (${s.deadlineMs}ms)` : ""}` };
  }
  if (s.aborted) return { status: "error", error: "run aborted by caller" };

  const budget = s.budgetHit ?? budgetFromSubtype(s.subtype);
  const overUsd = s.maxUsd !== undefined && s.usd !== undefined && s.usd >= s.maxUsd;
  if (budget === "turns") {
    return {
      status: "budget-exceeded",
      error: `turn budget exhausted${s.maxTurns ? ` (maxTurns ${s.maxTurns})` : ""}. ${RECOVERY_TURNS}`,
    };
  }
  if (budget === "usd" || (overUsd && (s.isError || (s.exitCode ?? 0) !== 0))) {
    const spent = s.usd !== undefined ? ` spent $${s.usd.toFixed(4)}` : "";
    const cap = s.maxUsd !== undefined ? ` of $${s.maxUsd}` : "";
    return { status: "budget-exceeded", error: `USD budget exhausted:${spent}${cap}. ${RECOVERY_USD}` };
  }
  if (s.isError || (s.exitCode !== undefined && s.exitCode !== null && s.exitCode !== 0)) {
    const what = s.subtype && s.subtype !== "success" ? s.subtype : `exit code ${s.exitCode ?? "unknown"}`;
    return { status: "error", error: s.detail ? `${what}: ${s.detail}` : what };
  }
  return { status: "ok" };
}
