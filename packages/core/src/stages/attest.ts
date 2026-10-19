import type { Policy } from "../policy/schema.js";
import type { ReviewerRun } from "../types.js";

/**
 * Proof of work. A hunter `pass` is only worth something if the runner observed the reviewer actually
 * looking: at least `policy.proofOfWork.minSubstantiveCalls` substantive tool calls and, when
 * `requireFilesRead`, at least one file read. A pass that falls short becomes `insufficient-work`; its
 * output is kept for provenance but it never counts toward quorum.
 *
 * Blocks are never discarded for lack of work (they go to the judges). Judge runs are not attested here.
 * The audit is runner-observed; nothing the model wrote is consulted.
 */
export function attest(run: ReviewerRun, policy: Policy): ReviewerRun {
  if (run.seat.role !== "hunter" || run.status !== "ok" || run.output?.verdict !== "pass") return run;
  const { minSubstantiveCalls, requireFilesRead } = policy.proofOfWork;
  const problems: string[] = [];
  if (run.audit.substantiveCalls < minSubstantiveCalls) {
    problems.push(`${run.audit.substantiveCalls} substantive tool calls (minimum ${minSubstantiveCalls})`);
  }
  if (requireFilesRead && run.audit.filesRead.length === 0) problems.push("no files read");
  if (problems.length === 0) return run;
  return { ...run, status: "insufficient-work", error: `pass rejected for insufficient work: ${problems.join("; ")}` };
}

/** A hunter run counts toward quorum only when it completed with valid, attested output. */
export function countsTowardQuorum(run: ReviewerRun): boolean {
  return run.seat.role === "hunter" && run.status === "ok" && run.output !== null;
}
