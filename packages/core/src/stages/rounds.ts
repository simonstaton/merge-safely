import type { Policy } from "../policy/schema.js";
import type { Change, Finding, ReviewerRun, Verdict } from "../types.js";
import { attest } from "./attest.js";
import { fingerprintFinding } from "./fingerprint.js";

export interface RoundPlan {
  round: number;
  /** Every unresolved finding from every prior verdict on the change (deduped, latest severity). */
  knownFindings: Finding[];
  /** The last reviewed SHA to diff from, when this round reviews only the delta. */
  sinceSha?: string;
  diffOnly: boolean;
  /** True when this round exceeds policy.rounds.max; the orchestrator escalates instead of reviewing. */
  capReached: boolean;
}

const sameChange = (v: Verdict, c: Change): boolean =>
  v.number === c.number && v.repo.host === c.repo.host && v.repo.owner === c.repo.owner && v.repo.name === c.repo.name;

const byRoundThenTime = (a: Verdict, b: Verdict): number =>
  a.round - b.round || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/**
 * True when a verdict is a real review a delta can be based on: not triaged, decided pass or block, not
 * contested, and at least one hunter seat actually completed. A pending verdict (every seat errored), a
 * triaged one (zero seats) or a contested one never put base..headSha in front of a model.
 */
export function reviewedCode(v: Verdict): boolean {
  return (
    !v.triaged &&
    !v.contested &&
    (v.decision === "pass" || v.decision === "block") &&
    v.seats.length > 0 &&
    v.seats.some((s) => s.seat.role === "hunter" && s.status === "ok" && s.output !== null)
  );
}

/**
 * The open findings across a change's history. Verdicts are replayed in round order: each verdict's
 * `addressed` ids close findings, its `findings` open (or refresh, latest severity wins) them, and a
 * human pass closes everything open at that point (a human accepted the change as it stood).
 */
export function openFindings(verdicts: Verdict[]): Finding[] {
  const open = new Map<string, Finding>();
  for (const v of [...verdicts].sort(byRoundThenTime)) {
    if (v.kind === "human") {
      if (v.decision === "pass") open.clear();
      continue;
    }
    for (const id of v.addressed ?? []) open.delete(id);
    for (const f of v.findings) {
      const id = fingerprintFinding(f);
      open.delete(id); // re-insert so the order follows the latest sighting
      open.set(id, { ...f, id });
    }
  }
  return [...open.values()];
}

/**
 * Plan the next round from prior verdicts for the same change (any SHA; verdicts for other changes are
 * ignored).
 * - round = max prior machine round + 1.
 * - knownFindings = every finding still open across all prior verdicts (see `openFindings`), so a
 *   blocker raised in round 1 and never addressed is still known in round 3.
 * - The round is diff-only (since the latest machine verdict's headSha) once
 *   round > policy.rounds.diffOnlyAfterRound, but only when that verdict actually reviewed code
 *   (`reviewedCode`) and its SHA differs from the current head. Otherwise it is a full review from base.
 */
export function planRound(input: { change: Change; priorVerdicts: Verdict[]; policy: Policy }): RoundPlan {
  const { change, policy } = input;
  const relevant = input.priorVerdicts.filter((v) => sameChange(v, change));
  const machine = relevant.filter((v) => v.kind === "machine").sort(byRoundThenTime);
  const last = machine[machine.length - 1];
  const round = last ? last.round + 1 : 1;
  const capReached = round > policy.rounds.max;
  const knownFindings = openFindings(relevant);
  if (last && round > policy.rounds.diffOnlyAfterRound && last.headSha !== change.headSha && reviewedCode(last)) {
    return { round, knownFindings, sinceSha: last.headSha, diffOnly: true, capReached };
  }
  return { round, knownFindings, diffOnly: false, capReached };
}

/**
 * Decide which known findings this round addressed. A known finding is addressed only when ALL hold:
 * 1. no hunter re-raised the same fingerprint (in any run output) and it is not among `surviving`;
 * 2. at least one attested hunter (status ok after `attest`) lists it in `output.addressed`;
 * 3. for blocker/important findings, a strict majority of attested hunters list it.
 * Runs that are insufficient-work, errored, timed out or schema-invalid never count as attested.
 * Everything else is carried.
 */
export function reconcileRounds(
  known: Finding[],
  runs: ReviewerRun[],
  surviving: Finding[],
  policy: Policy,
): { addressed: string[]; carried: string[] } {
  const hunters = runs.filter((r) => r.seat.role === "hunter");
  const attested = hunters.map((r) => attest(r, policy)).filter((r) => r.status === "ok" && r.output !== null);
  const reRaised = new Set<string>(surviving.map((f) => fingerprintFinding(f)));
  for (const r of hunters) for (const f of r.output?.findings ?? []) reRaised.add(fingerprintFinding(f));

  const addressed: string[] = [];
  const carried: string[] = [];
  for (const k of known) {
    const listed = attested.filter((r) => r.output?.addressed?.includes(k.id)).length;
    const serious = k.severity === "blocker" || k.severity === "important";
    const ok = !reRaised.has(k.id) && listed >= 1 && (!serious || listed * 2 > attested.length);
    (ok ? addressed : carried).push(k.id);
  }
  return { addressed, carried };
}

export type AcceptResult = { ok: true } | { ok: false; reason: string; contested?: boolean };

/**
 * The no-downgrade guard, checked before a compare-and-set into the verdict store.
 * - No stored verdict, or a stored verdict for a different SHA: accept.
 * - Human verdicts may replace anything. A machine verdict may not replace a human one.
 * - Same round and same decision: idempotent, accept.
 * - An older round may not replace a newer one.
 * - Same SHA: a machine pass or pending never replaces a stored machine block that has blocker/important
 *   findings, whatever `incoming.addressed` claims. The code has not changed, so the block stands until a
 *   human resolves it; the result is `contested`. (Across SHAs, carried findings are enforced by
 *   `aggregate`, not here.)
 */
export function canAcceptVerdict(stored: Verdict | null, incoming: Verdict): AcceptResult {
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
    const open = stored.findings.filter((f) => f.severity === "blocker" || f.severity === "important").map((f) => f.id);
    if (open.length > 0) {
      return {
        ok: false,
        contested: true,
        reason: `a machine block is stored for this SHA with open findings (${open.join(", ")}); only a human verdict can replace it`,
      };
    }
  }
  return { ok: true };
}
