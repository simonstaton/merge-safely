import type { Policy } from "../policy/schema.js";
import type { ReviewerRun } from "../types.js";

/**
 * Proof of work. A verdict is only worth something if the runner observed the reviewer actually looking:
 * at least `policy.proofOfWork.minSubstantiveCalls` substantive tool calls and, when `requireFilesRead`,
 * at least one file read. The audit is runner-observed; nothing the model wrote is consulted.
 *
 * - Hunter `pass` that falls short -> `insufficient-work`; output kept for provenance, never counts
 *   toward quorum. Hunter blocks are never discarded for lack of work (they go to the judges).
 * - Judge runs that fall short -> `insufficient-work`; their votes are ignored. A refute is a pass in
 *   effect, so a judge that did not look cannot clear a blocker.
 * Idempotent: an already-attested run is returned unchanged.
 */
export function attest(run: ReviewerRun, policy: Policy): ReviewerRun {
  if (run.status !== "ok") return run;
  const isHunterPass = run.seat.role === "hunter" && run.output?.verdict === "pass";
  const isJudge = run.seat.role === "judge" && run.judgeOutput != null;
  if (!isHunterPass && !isJudge) return run;
  const { minSubstantiveCalls, requireFilesRead } = policy.proofOfWork;
  const problems: string[] = [];
  if (run.audit.substantiveCalls < minSubstantiveCalls) {
    problems.push(`${run.audit.substantiveCalls} substantive tool calls (minimum ${minSubstantiveCalls})`);
  }
  if (requireFilesRead && run.audit.filesRead.length === 0) problems.push("no files read");
  if (problems.length === 0) return run;
  const what = isJudge ? "judge votes ignored" : "pass rejected";
  return { ...run, status: "insufficient-work", error: `${what} for insufficient work: ${problems.join("; ")}` };
}

/** A hunter run counts toward quorum only when it completed with valid output that survives attestation. */
export function countsTowardQuorum(run: ReviewerRun, policy?: Policy): boolean {
  const r = policy ? attest(run, policy) : run;
  return r.seat.role === "hunter" && r.status === "ok" && r.output !== null;
}
