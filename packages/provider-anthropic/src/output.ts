import {
  JUDGE_OUTPUT_JSON_SCHEMA,
  type JudgeOutput,
  parseJudgeOutput,
  parseReviewerOutput,
  REVIEWER_OUTPUT_JSON_SCHEMA,
  type ReviewerInput,
  type ReviewerOutput,
  type ReviewerRun,
  type RunStatus,
  type Seat,
  type ToolUseAudit,
} from "@merge-safely/core";
import { scrub, scrubDeep } from "./secrets.js";

export type ParsedOutput =
  | { ok: true; role: "hunter"; output: ReviewerOutput }
  | { ok: true; role: "judge"; judgeOutput: JudgeOutput }
  | { ok: false; error: string };

/** Validate a final JSON value against the seat's role schema. */
export function parseForSeat(seat: Seat, raw: unknown): ParsedOutput {
  if (seat.role === "judge") {
    const r = parseJudgeOutput(raw);
    return r.ok ? { ok: true, role: "judge", judgeOutput: r.value } : { ok: false, error: r.error };
  }
  const r = parseReviewerOutput(raw);
  return r.ok ? { ok: true, role: "hunter", output: r.value } : { ok: false, error: r.error };
}

/** The JSON schema to hand the model: the input's, else the core default for the role. `$schema` is dropped. */
export function outputSchemaFor(seat: Seat, input: ReviewerInput): Record<string, unknown> {
  const base: Record<string, unknown> =
    input.outputSchema && Object.keys(input.outputSchema).length > 0
      ? input.outputSchema
      : seat.role === "judge"
        ? (JUDGE_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>)
        : (REVIEWER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>);
  const { $schema: _drop, ...rest } = base;
  return { ...rest, type: "object" };
}

export function buildRun(args: {
  seat: Seat;
  input: ReviewerInput;
  ws: { headSha: string };
  parsed?: ParsedOutput;
  audit: ToolUseAudit;
  status: RunStatus;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  /**
   * Known secret values; every string in the output and the error is scrubbed of them. Output then gets the
   * precise shape redactor (code in evidence stays as written), the error string the aggressive one.
   */
  secrets: readonly string[];
}): ReviewerRun {
  const { seat, secrets } = args;
  // Findings get posted publicly: a seat that read a credential must never be able to quote it.
  const parsed = args.parsed?.ok ? scrubDeep(args.parsed, secrets) : args.parsed;
  const ok = parsed?.ok === true;
  const run: ReviewerRun = {
    seat,
    headSha: args.ws.headSha,
    round: args.input.round,
    output: ok && parsed.role === "hunter" ? parsed.output : null,
    audit: args.audit,
    status: args.status,
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
  };
  if (seat.role === "judge") run.judgeOutput = ok && parsed.role === "judge" ? parsed.judgeOutput : null;
  if (args.error) run.error = scrub(args.error, secrets);
  return run;
}
