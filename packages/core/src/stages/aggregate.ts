import type { Policy } from "../policy/schema.js";
import type { Decision, Finding, ReviewerRun, Tier, Verdict } from "../types.js";
import { attest } from "./attest.js";
import { dedupeFindings, fingerprintFinding, SEVERITY_RANK } from "./fingerprint.js";

export interface AggregateInput {
  tier: Tier;
  hunterRuns: ReviewerRun[];
  judgeRuns: ReviewerRun[];
  /** Surviving findings after the judge phase. */
  findings: Finding[];
  policy: Policy;
  judgesCounted: number;
}

export interface AggregateResult {
  decision: Decision;
  quorum: Verdict["quorum"];
  findings: Finding[];
  reasons: string[];
}

/** Valid passes needed for a tier: policy.quorum.t1/t2/t3, and 1 for tier 0. */
export function requiredPasses(level: Tier["level"], policy: Policy): number {
  if (level === 3) return policy.quorum.t3;
  if (level === 2) return policy.quorum.t2;
  if (level === 1) return policy.quorum.t1;
  return 1;
}

const cmp = (a: string | undefined, b: string | undefined): number => {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
};

/** Rank by severity (blocker first), then class, then file (file-less last), then line, then id. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      cmp(a.class, b.class) ||
      cmp(a.file, b.file) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      cmp(a.id, b.id),
  );
}

const where = (f: Finding): string => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "");

/**
 * Aggregate a round into a decision.
 * - passed: hunter runs that are ok with verdict pass after proof-of-work attestation.
 * - blocked: ok hunter blocks with at least one finding that survived the judges at blocker/important
 *   severity. A block whose findings were all refuted or downgraded below important does not count.
 * - invalid: every other hunter run (failed, timed out, insufficient work, refuted blocks).
 * Decision: block if any surviving blocker or blocked > 0; pass if passed >= required; else pending.
 * Hunter finding ids are always recomputed from content: ids the model wrote are never trusted.
 */
export function aggregate(input: AggregateInput): AggregateResult {
  const { tier, policy, judgesCounted } = input;
  const required = requiredPasses(tier.level, policy);
  const findings = rankFindings(dedupeFindings(input.findings));
  const surviving = new Map(findings.map((f) => [f.id, f]));

  let passed = 0;
  let blocked = 0;
  const failed: string[] = [];
  for (const raw of input.hunterRuns) {
    const run = attest(raw, policy);
    const label = run.seat.id || run.seat.lens;
    if (run.status !== "ok" || run.output === null) {
      failed.push(`${label} (${run.status})`);
      continue;
    }
    if (run.output.verdict === "pass") {
      passed++;
      continue;
    }
    const upheld = run.output.findings.some((f) => {
      const s = surviving.get(fingerprintFinding(f));
      return s !== undefined && (s.severity === "blocker" || s.severity === "important");
    });
    if (upheld) blocked++;
    else failed.push(`${label} (block not upheld by judges)`);
  }
  const invalid = input.hunterRuns.length - passed - blocked;
  const quorum = { required, passed, blocked, invalid };

  const reasons: string[] = [`quorum: ${required} required, ${passed} passed, ${blocked} blocked, ${invalid} invalid`];
  const blockers = findings.filter((f) => f.severity === "blocker");
  if (judgesCounted === 0 && findings.length > 0) {
    reasons.push(
      input.judgeRuns.length > 0
        ? `unjudged: all ${input.judgeRuns.length} judge seats failed; ${findings.length} findings were not verified`
        : `unjudged: no judge phase ran; ${findings.length} findings were not verified`,
    );
  }

  let decision: Decision;
  if (blockers.length > 0 || blocked > 0) {
    decision = "block";
    for (const f of blockers) reasons.push(`blocker [${f.class}] ${f.title}${where(f)}`);
    if (blocked > 0) reasons.push(`${blocked} hunter seat${blocked === 1 ? "" : "s"} blocked with upheld findings`);
  } else if (passed >= required) {
    decision = "pass";
    reasons.push(`${passed} valid pass${passed === 1 ? "" : "es"} meet the tier ${tier.level} quorum of ${required}`);
  } else {
    decision = "pending";
    const missing = required - passed;
    const seats = failed.length > 0 ? `; failed seats: ${failed.join(", ")}` : "";
    reasons.push(
      `missing ${missing} valid pass${missing === 1 ? "" : "es"} (have ${passed} of ${required} required)${seats}`,
    );
  }

  return { decision, quorum, findings, reasons };
}
