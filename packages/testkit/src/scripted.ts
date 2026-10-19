import type { Finding, JudgeOutput, ReviewerInput, ReviewerOutput, Seat } from "@merge-safely/core";
import { confirmAll, passOutput, type Script, type ScriptResult } from "./provider.js";

export type HunterBehaviour =
  | "pass"
  | "block"
  | "timeout"
  | "error"
  | "insufficient-work"
  | "budget-exceeded"
  | ScriptResult
  | Script;

export type JudgeBehaviour =
  | "confirm"
  | "refute"
  | "downgrade"
  | "timeout"
  | "error"
  | "insufficient-work"
  | "budget-exceeded"
  | ScriptResult
  | Script;

/**
 * Behaviour per seat. Keys are matched in order: the seat id ("hunter:security:1"), the persona, the lens
 * ("security"), then "*". Unmatched hunters pass and unmatched judges confirm.
 */
export interface ScriptedRunsSpec {
  hunters?: Record<string, HunterBehaviour>;
  judges?: Record<string, JudgeBehaviour>;
}

/** The blocker a "block" hunter raises: on the first changed file, fingerprinted by lens. */
export function sampleBlocker(seat: Seat, input: ReviewerInput): Finding {
  const file = input.change.files[0]?.path;
  return {
    id: `fake:${seat.lens}:blocker`,
    severity: "blocker",
    class: "logic-error",
    title: `${seat.lens}: change breaks an invariant`,
    detail: "Scripted blocker from @merge-safely/testkit.",
    ...(file ? { file, line: 1 } : {}),
    evidence: file ? [`${file}:1`] : [],
  };
}

function lookup<T>(table: Record<string, T> | undefined, seat: Seat): T | undefined {
  if (!table) return undefined;
  for (const k of [seat.id, seat.persona, seat.lens, "*"]) {
    if (k !== undefined && Object.hasOwn(table, k)) return table[k];
  }
  return undefined;
}

function failure(kind: "timeout" | "error" | "insufficient-work" | "budget-exceeded", seat: Seat): ScriptResult {
  switch (kind) {
    case "timeout":
      return {
        status: "timeout",
        output: null,
        error: `seat ${seat.id} hit its ${seat.budget.deadlineMs}ms deadline`,
        audit: {
          substantiveCalls: 2,
          totalCalls: 3,
          filesRead: ["src/index.ts"],
          commandsRun: [],
          tokens: { in: 4000, out: 300 },
          wallMs: seat.budget.deadlineMs,
          turns: 2,
        },
      };
    case "error":
      return new Error(`fake provider error for seat ${seat.id}`);
    case "insufficient-work":
      return {
        status: "insufficient-work",
        // The model claimed a pass without investigating; the runner-observed audit says otherwise.
        output: passOutput("Looks fine to me."),
        error: "0 substantive tool calls, 0 files read",
        audit: {
          substantiveCalls: 0,
          totalCalls: 1,
          filesRead: [],
          commandsRun: [],
          tokens: { in: 1500, out: 80 },
          wallMs: 400,
          turns: 1,
        },
      };
    case "budget-exceeded": {
      const maxUsd = seat.budget.maxUsd ?? 0.5;
      return {
        status: "budget-exceeded",
        output: null,
        error: `seat ${seat.id} exceeded its $${maxUsd} budget`,
        audit: {
          substantiveCalls: 7,
          totalCalls: 9,
          filesRead: ["src/index.ts", "src/a.ts", "src/b.ts"],
          commandsRun: [],
          tokens: { in: 200_000, out: 20_000 },
          costUsd: maxUsd,
          wallMs: 30_000,
          turns: seat.budget.maxTurns,
        },
      };
    }
  }
}

function judgeVotes(decision: "refute" | "downgrade", input: ReviewerInput): JudgeOutput {
  return {
    votes: (input.candidateFindings ?? []).map((f) =>
      decision === "refute"
        ? { findingId: f.id, decision, reason: "Not reproducible from the code." }
        : { findingId: f.id, decision, severity: "nit" as const, reason: "Real but minor." },
    ),
    summary: decision === "refute" ? "Refuted every candidate." : "Downgraded every candidate.",
  };
}

/** Build a Script from a per-seat behaviour table. */
export function scriptedRuns(spec: ScriptedRunsSpec = {}): Script {
  return async (seat, input) => {
    if (seat.role === "judge") {
      const b = lookup(spec.judges, seat) ?? "confirm";
      if (typeof b === "function") return b(seat, input);
      if (typeof b !== "string") return b;
      if (b === "confirm") return confirmAll(input.candidateFindings);
      if (b === "refute" || b === "downgrade") return judgeVotes(b, input);
      return failure(b, seat);
    }
    const b = lookup(spec.hunters, seat) ?? "pass";
    if (typeof b === "function") return b(seat, input);
    if (typeof b !== "string") return b;
    if (b === "pass") return passOutput();
    if (b === "block") {
      const out: ReviewerOutput = {
        verdict: "block",
        summary: `${seat.lens} found a blocker.`,
        findings: [sampleBlocker(seat, input)],
      };
      return out;
    }
    return failure(b, seat);
  };
}

/** Ready-made scripts for the common pipeline cases. `key` is a seat id, persona or lens. */
export const scenarios = {
  allPass: (): Script => scriptedRuns(),
  oneBlocker: (key = "correctness"): Script => scriptedRuns({ hunters: { [key]: "block" } }),
  judgesRefuteAll: (key = "correctness"): Script =>
    scriptedRuns({ hunters: { [key]: "block" }, judges: { "*": "refute" } }),
  seatTimesOut: (key: string): Script => scriptedRuns({ hunters: { [key]: "timeout" }, judges: { [key]: "timeout" } }),
  seatErrors: (key: string): Script => scriptedRuns({ hunters: { [key]: "error" }, judges: { [key]: "error" } }),
  insufficientWork: (key: string): Script =>
    scriptedRuns({ hunters: { [key]: "insufficient-work" }, judges: { [key]: "insufficient-work" } }),
  budgetExceeded: (key: string): Script =>
    scriptedRuns({ hunters: { [key]: "budget-exceeded" }, judges: { [key]: "budget-exceeded" } }),
};
