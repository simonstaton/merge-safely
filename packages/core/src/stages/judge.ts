import type { Policy } from "../policy/schema.js";
import type { Finding, JudgeVote, ReviewerRun, Severity } from "../types.js";
import { assignFingerprints, dedupeFindings, minSeverity, SEVERITY_RANK } from "./fingerprint.js";

export interface JudgeResult {
  surviving: Finding[];
  /** Candidates that failed the agreement threshold, and judge-raised findings nobody seconded. */
  refuted: Finding[];
  /** Findings removed because their class is in `policy.quorum.dropClasses`. */
  dropped: Finding[];
  judgesCounted: number;
}

const SEVERITY_ORDER: Severity[] = ["blocker", "important", "nit", "pre-existing"];

function oneStepDown(s: Severity): Severity {
  return SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, SEVERITY_RANK[s] + 1)] ?? s;
}

/** A judge run's vote counts only when the run completed and produced judge output. */
export function judgeCounts(run: ReviewerRun): boolean {
  return run.seat.role === "judge" && run.status === "ok" && run.judgeOutput != null;
}

/**
 * Apply judge votes to the hunters' candidate findings.
 *
 * Rules:
 * 1. Only judge runs with status "ok" and a judgeOutput count; `judgesCounted` is how many.
 * 2. Findings whose class is in `policy.quorum.dropClasses` are dropped outright (also when unjudged).
 * 3. Each counted judge has at most one vote per finding (its last). Votes on unknown ids are ignored.
 *    A judge that does not vote on a candidate is counted as not agreeing.
 * 4. agreement = (confirm + downgrade votes) / judgesCounted. A candidate survives when
 *    agreement >= `policy.quorum.judgeAgreement`; otherwise it is refuted.
 * 5. Downgrade votes lower a surviving finding to the lowest severity among them (never raise it).
 *    A downgrade vote without a severity means one step down.
 * 6. judgesCounted === 0: every non-dropped candidate survives unchanged (aggregate notes "unjudged").
 * 7. Judge `newFindings` are fingerprinted. One that matches a candidate id counts as that judge's
 *    confirm vote when it did not vote on it. A genuinely new finding survives when raised by >= 2
 *    judges (at the lowest severity they gave), or by the only judge when judgesCounted === 1, capped
 *    at "important". Otherwise it is refuted as unconfirmed.
 * 8. Surviving findings carry every counted vote cast on them (with the judge's seat id).
 */
export function applyJudgeVotes(candidates: Finding[], judgeRuns: ReviewerRun[], policy: Policy): JudgeResult {
  const drop = new Set(policy.quorum.dropClasses.map((c) => c.toLowerCase()));
  const isDropped = (f: Finding) => drop.has(f.class.trim().toLowerCase());
  const deduped = dedupeFindings(candidates);
  const dropped = deduped.filter(isDropped);
  const kept = deduped.filter((f) => !isDropped(f));

  const judges = judgeRuns.filter(judgeCounts);
  const judgesCounted = judges.length;
  if (judgesCounted === 0) return { surviving: kept, refuted: [], dropped, judgesCounted };

  const known = new Map(kept.map((f) => [f.id, f]));
  // votes[findingId][seatId] = vote
  const votes = new Map<string, Map<string, JudgeVote>>();
  const castVote = (v: JudgeVote) => {
    const seatVotes = votes.get(v.findingId) ?? new Map<string, JudgeVote>();
    seatVotes.set(v.seatId ?? "", v);
    votes.set(v.findingId, seatVotes);
  };

  // New findings by fingerprint: which judges raised them, and each raised copy.
  const raised = new Map<string, { seats: Set<string>; copies: Finding[] }>();

  judges.forEach((run, index) => {
    const seatId = run.seat.id || `judge#${index}`;
    for (const v of run.judgeOutput?.votes ?? []) {
      if (known.has(v.findingId)) castVote({ ...v, seatId });
    }
    const fresh = assignFingerprints(run.judgeOutput?.newFindings ?? []).map((f) => ({
      ...f,
      lenses: [...new Set([...(f.lenses ?? []), run.seat.lens])],
    }));
    for (const f of fresh) {
      if (isDropped(f)) {
        dropped.push(f);
        continue;
      }
      if (known.has(f.id)) {
        if (!votes.get(f.id)?.has(seatId)) {
          castVote({ findingId: f.id, decision: "confirm", reason: "independently raised by judge", seatId });
        }
        continue;
      }
      const entry = raised.get(f.id) ?? { seats: new Set<string>(), copies: [] };
      entry.seats.add(seatId);
      entry.copies.push(f);
      raised.set(f.id, entry);
    }
  });

  const surviving: Finding[] = [];
  const refuted: Finding[] = [];
  for (const f of kept) {
    const cast = [...(votes.get(f.id)?.values() ?? [])];
    const agreeing = cast.filter((v) => v.decision === "confirm" || v.decision === "downgrade").length;
    const withVotes: Finding = cast.length > 0 ? { ...f, votes: [...(f.votes ?? []), ...cast] } : { ...f };
    if (agreeing / judgesCounted < policy.quorum.judgeAgreement) {
      refuted.push(withVotes);
      continue;
    }
    let severity = f.severity;
    for (const v of cast) {
      if (v.decision !== "downgrade") continue;
      severity = minSeverity(severity, v.severity ?? oneStepDown(f.severity));
    }
    surviving.push({ ...withVotes, severity });
  }

  for (const [id, entry] of raised) {
    const merged = dedupeFindings(entry.copies)[0];
    if (!merged) continue;
    const lowest = entry.copies.reduce<Severity>((s, c) => minSeverity(s, c.severity), "blocker");
    const confirmations: JudgeVote[] = [...entry.seats].map((seatId) => ({
      findingId: id,
      decision: "confirm",
      reason: "raised by judge",
      seatId,
    }));
    const finding: Finding = { ...merged, votes: [...(merged.votes ?? []), ...confirmations] };
    if (entry.seats.size >= 2) {
      surviving.push({ ...finding, severity: lowest });
    } else if (judgesCounted === 1) {
      surviving.push({ ...finding, severity: minSeverity(lowest, "important") });
    } else {
      refuted.push(finding);
    }
  }

  return { surviving, refuted, dropped, judgesCounted };
}
