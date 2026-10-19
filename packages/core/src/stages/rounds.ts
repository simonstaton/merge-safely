import type { Policy } from "../policy/schema.js";
import type { Change, Finding, ReviewerRun, Verdict } from "../types.js";
import { fingerprintFinding } from "./fingerprint.js";

export interface RoundPlan {
  round: number;
  knownFindings: Finding[];
  /** The last reviewed SHA to diff from, when this round reviews only the delta. */
  sinceSha?: string;
  diffOnly: boolean;
  /** True when this round exceeds policy.rounds.max; the orchestrator escalates instead of reviewing. */
  capReached: boolean;
}

const sameChange = (v: Verdict, c: Change): boolean =>
  v.number === c.number && v.repo.host === c.repo.host && v.repo.owner === c.repo.owner && v.repo.name === c.repo.name;

/** The latest verdict: highest round, ties broken by createdAt. */
function latest(verdicts: Verdict[]): Verdict | undefined {
  return verdicts.reduce<Verdict | undefined>((best, v) => {
    if (!best) return v;
    if (v.round !== best.round) return v.round > best.round ? v : best;
    return v.createdAt > best.createdAt ? v : best;
  }, undefined);
}

/**
 * Plan the next round from prior machine verdicts for the same change (any SHA; human verdicts and
 * verdicts for other changes are ignored). round = max prior round + 1. knownFindings are the latest
 * verdict's findings. The round is diff-only (since the latest verdict's headSha) once
 * round > policy.rounds.diffOnlyAfterRound, unless that SHA equals the current head (a re-run on the
 * same commit has an empty delta, so it gets the full diff).
 */
export function planRound(input: { change: Change; priorVerdicts: Verdict[]; policy: Policy }): RoundPlan {
  const { change, policy } = input;
  const prior = input.priorVerdicts.filter((v) => v.kind === "machine" && sameChange(v, change));
  const last = latest(prior);
  const round = last ? last.round + 1 : 1;
  const capReached = round > policy.rounds.max;
  const knownFindings = last ? [...last.findings] : [];
  if (last && round > policy.rounds.diffOnlyAfterRound && last.headSha !== change.headSha) {
    return { round, knownFindings, sinceSha: last.headSha, diffOnly: true, capReached };
  }
  return { round, knownFindings, diffOnly: false, capReached };
}

/**
 * Decide which known findings this round addressed. A known finding is addressed when a strict majority
 * of ok hunter runs list it in `output.addressed`, or when at least one run lists it and no hunter
 * re-raised the same fingerprint (and it is not among this round's surviving findings). Otherwise it is
 * carried. With no ok hunter runs, everything is carried.
 */
export function reconcileRounds(
  known: Finding[],
  runs: ReviewerRun[],
  surviving: Finding[],
): { addressed: string[]; carried: string[] } {
  const ok = runs.filter((r) => r.seat.role === "hunter" && r.status === "ok" && r.output !== null);
  const reRaised = new Set<string>(surviving.map((f) => f.id));
  for (const r of ok) for (const f of r.output?.findings ?? []) reRaised.add(fingerprintFinding(f));

  const addressed: string[] = [];
  const carried: string[] = [];
  for (const k of known) {
    const listed = ok.filter((r) => r.output?.addressed?.includes(k.id)).length;
    const majority = ok.length > 0 && listed * 2 > ok.length;
    if (majority || (listed >= 1 && !reRaised.has(k.id))) addressed.push(k.id);
    else carried.push(k.id);
  }
  return { addressed, carried };
}

/**
 * The no-downgrade guard, checked before a compare-and-set into the verdict store.
 * - No stored verdict, or a stored verdict for a different SHA: accept.
 * - Human verdicts may replace anything. A machine verdict may not replace a human one.
 * - Same round and same decision: idempotent, accept.
 * - An older round may not replace a newer one.
 * - A machine verdict that is not a block (pass or pending) may not replace a stored machine block for
 *   the same SHA unless every stored blocker/important finding id is in `incoming.addressed`.
 */
export function canAcceptVerdict(
  stored: Verdict | null,
  incoming: Verdict,
): { ok: true } | { ok: false; reason: string } {
  if (!stored || stored.headSha !== incoming.headSha) return { ok: true };
  if (incoming.kind === "human") return { ok: true };
  if (stored.kind === "human") {
    return { ok: false, reason: "a human verdict is stored for this SHA; a machine verdict cannot replace it" };
  }
  if (stored.round === incoming.round && stored.decision === incoming.decision) return { ok: true };
  if (incoming.round < stored.round) {
    return { ok: false, reason: `stale round ${incoming.round}; round ${stored.round} is already stored` };
  }
  if (stored.decision === "block" && incoming.decision !== "block") {
    const addressed = new Set(incoming.addressed ?? []);
    const open = stored.findings
      .filter((f) => f.severity === "blocker" || f.severity === "important")
      .map((f) => f.id)
      .filter((id) => !addressed.has(id));
    if (open.length > 0) {
      return {
        ok: false,
        reason: `stored block for this SHA has unresolved findings: ${open.join(", ")}; a ${incoming.decision} cannot replace it`,
      };
    }
  }
  return { ok: true };
}
