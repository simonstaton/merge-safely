/**
 * The orchestrator (design 4.2, 4.3): wires the pure stages to the ports.
 *
 *   review: getChange -> pin head -> intake -> tier -> rounds plan -> pending -> trust -> [cap: escalate]
 *           -> triage [auto-pass] -> diff -> seat -> budget [downgrade | budget-blocked] -> hunters
 *           -> attest + fingerprint + redact -> judges (+ second round on split votes) -> judge votes
 *           -> reconcile rounds -> aggregate -> verdict -> no-downgrade guard + CAS -> digest -> report
 *           -> escalate -> metrics
 *
 * Every port call is wrapped: once a change is known, any failure reports an `error` event and rejects with a
 * GateError whose message is secret-scrubbed. Reporters, metrics, ledger appends and escalation never fail a review.
 * The gate holds no per-review state between calls; all timestamps come from `deps.clock`.
 */
import { ceilingMessage, evaluateCeilings } from "../budget/ceilings.js";
import { estimatePanel } from "../budget/seat-budget.js";
import { SeatingError } from "../panel/errors.js";
import { describeSeating, type SeatingResult, seat } from "../panel/seating.js";
import type { SourceProvider } from "../ports.js";
import { aggregate, rankFindings, requiredPasses } from "../stages/aggregate.js";
import { attest } from "../stages/attest.js";
import { renderBudgetBlockedDigest, renderDigest } from "../stages/digest.js";
import { dedupeFindings } from "../stages/fingerprint.js";
import { type IntakeContext, intake, redactDiff, redactText } from "../stages/intake.js";
import { applyJudgeVotes, judgeCounts } from "../stages/judge.js";
import { canAcceptVerdict, openFindings, planRound, type RoundPlan, reconcileRounds } from "../stages/rounds.js";
import { tier as tierOf } from "../stages/tiering.js";
import { triage } from "../stages/triage.js";
import type {
  Change,
  ChangeRef,
  Decision,
  EscalationHandle,
  Finding,
  HumanDigest,
  ReportEvent,
  ReviewerRun,
  Seat,
  Tier,
  TrustClass,
  UntrustedText,
  Verdict,
  VerdictCost,
  VerdictKey,
} from "../types.js";
import { type BudgetPlan, ceilingPolicyName, planBudget, scopeIdFor, seatEstimator, spendInputs } from "./budget.js";
import { catalogOf, type Env, emit, fail, guard, makeEnv, nowIso, RunState, report, safeText } from "./env.js";
import { GateError } from "./errors.js";
import { mapLimit } from "./limit.js";
import { type RoundContext, runSeat, type SeatOutcome, sanitiseRun } from "./seats.js";
import type { Estimate, Gate, GateDeps, HumanVerdictInput, ReviewChangeContext, ReviewResult } from "./types.js";
import { addUsage, estimateDiffChars } from "./util.js";

export function createGate(deps: GateDeps): Gate {
  const env = makeEnv(deps);
  return {
    review: (ref, opts) => review(env, ref, opts ?? {}),
    reviewChange: (change, ctx, opts) => reviewChange(env, change, ctx, opts ?? {}),
    estimate: (target) => estimate(env, target),
    explain: (ref) => explain(env, ref),
    recordHumanVerdict: (input) => recordHumanVerdict(env, input),
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface DiffSource {
  full(): Promise<string>;
  /** Undefined when no delta is available; the round then reviews the full diff. */
  delta?: (sinceSha: string) => Promise<string>;
}

const short = (sha: string): string => sha.slice(0, 7);

function requireSource(env: Env, what: string): SourceProvider {
  const s = env.deps.source;
  if (!s)
    throw new GateError("source", `${what} needs a SourceProvider; use reviewChange() for a change you already hold`);
  return s;
}

async function review(env: Env, ref: ChangeRef, opts: { headSha?: string; trigger?: string }): Promise<ReviewResult> {
  const state = new RunState();
  const source = requireSource(env, "review()");
  const change = await guard(env, "source", "could not load the change", () => source.getChange(ref));
  // Error events carry the redacted change from here on.
  state.change = intake(change, {}, env.policy).change;
  if (opts.headSha !== undefined && opts.headSha !== change.headSha) {
    throw await fail(
      env,
      state,
      new GateError(
        "head-moved",
        `head moved: asked to review ${short(opts.headSha)} but the change head is now ${short(change.headSha)}; the newer push gets its own review`,
      ),
    );
  }
  const headSha = change.headSha;
  let ctx: IntakeContext = {};
  if (source.getUntrustedContext) {
    try {
      ctx = await source.getUntrustedContext(ref);
    } catch (err: unknown) {
      env.logger.warn("could not load commit messages and comments; reviewing without them", {
        error: safeText(env, err),
      });
    }
  }
  const diffs: DiffSource = {
    full: () => guard(env, "source", "could not fetch the diff", () => source.getDiff(ref, { headSha })),
    delta: (sinceSha) =>
      guard(env, "source", "could not fetch the delta diff", () => source.getDiff(ref, { sinceSha, headSha })),
  };
  return pipeline(env, state, change, ctx, diffs, opts.trigger);
}

async function reviewChange(
  env: Env,
  change: Change,
  ctx: ReviewChangeContext,
  opts: { trigger?: string },
): Promise<ReviewResult> {
  const state = new RunState();
  const diffs: DiffSource = { full: async () => ctx.diff };
  const delta = ctx.deltaDiff;
  if (delta !== undefined) diffs.delta = async () => delta;
  return pipeline(env, state, change, ctx.untrusted ?? {}, diffs, opts.trigger);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface ReviewBase {
  change: Change;
  tier: Tier;
  plan: RoundPlan;
  prior: Verdict[];
  trust: TrustClass;
  /** Trusted author at or below trust.trustedBypassMaxTier: never escalated. */
  bypass: boolean;
  startedMs: number;
}

const serious = (f: Finding): boolean => f.severity === "blocker" || f.severity === "important";

async function pipeline(
  env: Env,
  state: RunState,
  raw: Change,
  ictx: IntakeContext,
  diffs: DiffSource,
  trigger: string | undefined,
): Promise<ReviewResult> {
  const startedMs = env.clock.now().getTime();
  try {
    const { policy } = env;
    const { change, untrusted } = intake(raw, ictx, policy);
    state.change = change;
    const t = tierOf(change, policy);
    const prior = await guard(env, "internal", "verdict store unavailable", () =>
      env.deps.store.listForChange(change.repo, change.number),
    );
    const plan = planRound({ change, priorVerdicts: prior, policy });
    state.round = plan.round;
    const pending: ReportEvent = { type: "pending", change, tier: t, round: plan.round };
    if (trigger) pending.message = `Review triggered by ${redactText(trigger).slice(0, 200)}`;
    await report(env, state, pending);

    const trust = await classifyTrust(env, change);
    const bypass = trust === "trusted" && t.level <= policy.trust.trustedBypassMaxTier;
    const base: ReviewBase = { change, tier: t, plan, prior, trust, bypass, startedMs };

    if (plan.capReached) return await capReached(env, state, base);
    const tri = triage(change, t, policy);
    // A deterministic auto-pass never clears open blockers from an earlier round.
    if (tri.decision === "auto-pass" && !plan.knownFindings.some(serious)) {
      return await autoPass(env, state, base, tri.reason);
    }
    return await reviewPanel(env, state, base, untrusted, diffs);
  } catch (err: unknown) {
    throw await fail(env, state, err);
  }
}

async function classifyTrust(env: Env, change: Change): Promise<TrustClass> {
  const trust = env.deps.trust;
  if (!trust) return "standard";
  let cls: TrustClass;
  try {
    cls = await trust.classify(change.author, change.repo);
  } catch (err: unknown) {
    env.logger.warn("trust lookup failed; treating the author as standard", { error: safeText(env, err) });
    return "standard";
  }
  if (cls === "trusted" && change.author.kind !== "human" && env.policy.trust.botsAreStandard) return "standard";
  return cls;
}

function lightPathNote(env: Env, base: ReviewBase): string | undefined {
  if (!base.bypass) return undefined;
  return `light path: trusted author at tier ${base.tier.level} (trust.trustedBypassMaxTier = ${env.policy.trust.trustedBypassMaxTier}); no escalation, tier unchanged`;
}

function baseVerdict(env: Env, base: ReviewBase, fields: Partial<Verdict> & { decision: Decision }): Verdict {
  const { change } = base;
  const v: Verdict = {
    repo: change.repo,
    number: change.number,
    headSha: change.headSha,
    kind: "machine",
    tier: base.tier,
    round: base.plan.round,
    triaged: false,
    seats: [],
    findings: [],
    quorum: { required: requiredPasses(base.tier.level, env.policy), passed: 0, blocked: 0, invalid: 0 },
    cost: { usd: 0, tokens: { in: 0, out: 0 }, bySeat: {} },
    createdAt: nowIso(env),
    policyHash: env.policyHash,
    producedBy: env.producedBy,
    ...fields,
  };
  const note = lightPathNote(env, base);
  if (note) v.reason = v.reason ? `${note}. ${v.reason}` : note;
  return v;
}

async function capReached(env: Env, state: RunState, base: ReviewBase): Promise<ReviewResult> {
  const { plan, change } = base;
  const known = plan.knownFindings;
  const sameSha = base.prior
    .filter((v) => v.kind === "machine" && v.headSha === change.headSha && v.decision !== "pending")
    .sort((a, b) => a.round - b.round);
  const last = sameSha[sameSha.length - 1];
  // Re-running a capped commit keeps its decision; a new commit past the cap is never passed unseen.
  const decision: Decision = last ? last.decision : known.some(serious) ? "block" : "pending";
  const verdict = baseVerdict(env, base, {
    decision,
    findings: rankFindings(known),
    escalated: true,
    reason: `round cap reached (policy.rounds.max = ${env.policy.rounds.max}); no panel seated, a human must sign off`,
  });
  if (known.length > 0) verdict.carried = known.map((f) => f.id);
  const escalation = env.deps.escalation;
  const committed = await commit(env, state, verdict, { reportVerdict: !escalation });
  let handle: EscalationHandle | undefined;
  if (!committed.refused && escalation) {
    handle = await escalate(env, state, committed.verdict, committed.digest);
    if (!handle)
      await report(env, state, { type: "verdict", change, verdict: committed.verdict, digest: committed.digest });
  }
  emitVerdictMetrics(env, base, committed.verdict, { escalated: handle !== undefined, capReached: true });
  return result(state, committed, handle);
}

async function autoPass(env: Env, state: RunState, base: ReviewBase, reason: string): Promise<ReviewResult> {
  const verdict = baseVerdict(env, base, {
    decision: "pass",
    triaged: true,
    triageReason: reason,
    quorum: { required: 0, passed: 0, blocked: 0, invalid: 0 },
    reason: `triaged: ${reason}`,
  });
  const committed = await commit(env, state, verdict);
  emitVerdictMetrics(env, base, committed.verdict, { escalated: false });
  return result(state, committed);
}

async function reviewPanel(
  env: Env,
  state: RunState,
  base: ReviewBase,
  untrusted: UntrustedText,
  diffs: DiffSource,
): Promise<ReviewResult> {
  const { policy } = env;
  const { change, plan } = base;
  const t = base.tier;

  // Diff, pinned to the head; delta only when the plan allows it and a delta is available.
  let diffIsDelta = false;
  let sinceSha: string | undefined;
  let diff: string;
  if (plan.diffOnly && plan.sinceSha && diffs.delta) {
    diff = await diffs.delta(plan.sinceSha);
    diffIsDelta = true;
    sinceSha = plan.sinceSha;
  } else {
    diff = await diffs.full();
  }
  diff = redactDiff(diff, policy);

  let seating: SeatingResult;
  try {
    seating = seat({
      tier: t,
      change,
      policy,
      connections: env.deps.connections,
      catalog: (id) => catalogOf(env, id),
      normalise: env.normalise,
    });
  } catch (err: unknown) {
    if (err instanceof SeatingError) throw new GateError("seating", safeText(env, err), { fix: err.fix });
    throw err;
  }
  for (const w of seating.warnings) env.logger.warn(`seating: ${w}`);

  const scopeId = scopeIdFor(env, change);
  const spend = await spendInputs(env, change, scopeId);
  const estimate = seatEstimator(env, change, diff.length, seating.secondJudgeRound);
  const budget = planBudget(env, { seats: seating.seats, tier: t, spend, estimate });
  if (!budget.ok) return budgetBlocked(env, state, base, budget);
  const seats = budget.seats;

  const rc: RoundContext = {
    change,
    tier: t,
    round: plan.round,
    diff,
    diffIsDelta,
    untrusted,
    knownFindings: plan.knownFindings,
    scopeId,
  };
  if (sinceSha) rc.sinceSha = sinceSha;

  const outcomes: SeatOutcome[] = [];
  const hunterSeats = seats.filter((s) => s.role === "hunter");
  const judgeSeats = seats.filter((s) => s.role === "judge");

  const hunterOutcomes = await mapLimit(hunterSeats, env.concurrency, (s) => runSeat(env, rc, s));
  outcomes.push(...hunterOutcomes);
  const hunterRuns = hunterOutcomes.map((o) => attest(sanitiseRun(o.run), policy));

  // Hunter blocks are never discarded for lack of work: insufficient-work runs still contribute candidates.
  const candidates = dedupeFindings(
    hunterRuns
      .filter((r) => r.output !== null && (r.status === "ok" || r.status === "insufficient-work"))
      .flatMap((r) => r.output?.findings ?? []),
  );

  let judgeRuns: ReviewerRun[] = [];
  if (judgeSeats.length > 0 && candidates.length > 0) {
    const first = await mapLimit(judgeSeats, env.concurrency, (s) => runSeat(env, rc, s, { candidates }));
    outcomes.push(...first);
    judgeRuns = first.map((o) => attest(sanitiseRun(o.run), policy));
    if (seating.secondJudgeRound) {
      const split = splitFindings(candidates, judgeRuns, env);
      if (split.length > 0) {
        const second = await mapLimit(judgeSeats, env.concurrency, (s) =>
          runSeat(env, rc, s, { candidates: split, workspaceSeatId: `${s.id}:second` }),
        );
        outcomes.push(...second);
        const secondRuns = second.map((o) => attest(sanitiseRun(o.run), policy));
        judgeRuns = judgeRuns.map((r, i) => mergeJudgeRuns(r, secondRuns[i], split, env));
      }
    }
  }

  const judge = applyJudgeVotes(candidates, judgeRuns, policy);
  const rec = reconcileRounds(plan.knownFindings, hunterRuns, judge.surviving, policy);
  const carriedIds = new Set(rec.carried);
  const carried = plan.knownFindings.filter((f) => carriedIds.has(f.id));
  const agg = aggregate({ tier: t, hunterRuns, judgeRuns, judge, carried, policy });

  const cost = costOf(outcomes);
  const verdict = baseVerdict(env, base, {
    decision: agg.decision,
    seats: [...hunterRuns, ...judgeRuns],
    findings: agg.findings,
    quorum: agg.quorum,
    cost,
    reason: agg.reasons.join("; "),
  });
  if (budget.downgrades.length > 0) verdict.downgrades = budget.downgrades;
  if (plan.knownFindings.length > 0) {
    verdict.addressed = rec.addressed;
    verdict.carried = rec.carried;
  }

  // Every hunter produced nothing usable: an outage, reported as such before the (pending) verdict.
  const allFailed = hunterRuns.length > 0 && hunterRuns.every((r) => r.output === null);
  if (allFailed) {
    const list = hunterRuns.map((r) => `${r.seat.id} (${r.status}${r.error ? `: ${r.error}` : ""})`).join("; ");
    await report(env, state, {
      type: "error",
      change,
      error: safeText(env, `all ${hunterRuns.length} reviewer seats failed: ${list}`, 2_000),
      round: plan.round,
    });
  }

  const tier3Rule =
    t.level === 3 &&
    base.trust !== "trusted" &&
    policy.trust.escalateTier3ForStandardAuthors &&
    agg.decision === "block";
  const pendingRule = agg.decision === "pending";
  const blockedAuthor = base.trust === "blocked" && agg.decision !== "pass";
  const shouldEscalate = !base.bypass && (tier3Rule || pendingRule || blockedAuthor);
  const escalation = env.deps.escalation;
  if (shouldEscalate && escalation) verdict.escalated = true;

  const committed = await commit(env, state, verdict);
  let handle: EscalationHandle | undefined;
  if (!committed.refused && shouldEscalate && escalation) {
    handle = await escalate(env, state, committed.verdict, committed.digest);
  }
  emitVerdictMetrics(env, base, committed.verdict, { escalated: handle !== undefined });
  return result(state, committed, handle);
}

/** Candidates whose counted first-round votes include both agreement (confirm/downgrade) and a refute. */
function splitFindings(candidates: Finding[], judgeRuns: ReviewerRun[], env: Env): Finding[] {
  const counted = judgeRuns.filter((r) => judgeCounts(r, env.policy));
  return candidates.filter((f) => {
    const last = counted
      .map((r) => {
        const votes = (r.judgeOutput?.votes ?? []).filter((v) => v.findingId === f.id);
        return votes[votes.length - 1]?.decision;
      })
      .filter((d) => d !== undefined);
    return last.some((d) => d === "confirm" || d === "downgrade") && last.includes("refute");
  });
}

/**
 * Merge a judge's second-round run into its first: second-round votes on the split findings come last, so they are
 * the judge's vote of record (applyJudgeVotes keeps each judge's last vote). A failed second run leaves the first.
 */
function mergeJudgeRuns(first: ReviewerRun, second: ReviewerRun | undefined, split: Finding[], env: Env): ReviewerRun {
  if (!second || !judgeCounts(first, env.policy) || !judgeCounts(second, env.policy)) return first;
  const ids = new Set(split.map((f) => f.id));
  const a = first.judgeOutput;
  const b = second.judgeOutput;
  if (!a || !b) return first;
  const newFindings = [...(a.newFindings ?? []), ...(b.newFindings ?? [])];
  const judgeOutput = { ...a, votes: [...a.votes, ...b.votes.filter((v) => ids.has(v.findingId))] };
  if (newFindings.length > 0) judgeOutput.newFindings = newFindings;
  const audit = {
    substantiveCalls: first.audit.substantiveCalls + second.audit.substantiveCalls,
    totalCalls: first.audit.totalCalls + second.audit.totalCalls,
    filesRead: [...new Set([...first.audit.filesRead, ...second.audit.filesRead])],
    commandsRun: [...first.audit.commandsRun, ...second.audit.commandsRun],
    tokens: addUsage(first.audit.tokens, second.audit.tokens),
    wallMs: first.audit.wallMs + second.audit.wallMs,
    turns: first.audit.turns + second.audit.turns,
    ...(first.audit.costUsd !== undefined || second.audit.costUsd !== undefined
      ? { costUsd: (first.audit.costUsd ?? 0) + (second.audit.costUsd ?? 0) }
      : {}),
  };
  return { ...first, judgeOutput, audit, finishedAt: second.finishedAt };
}

function costOf(outcomes: SeatOutcome[]): VerdictCost {
  const bySeat: VerdictCost["bySeat"] = {};
  let usd = 0;
  let tokens = { in: 0, out: 0 };
  for (const o of outcomes) {
    usd += o.usd;
    tokens = addUsage(tokens, o.tokens);
    const served = o.run.fallbackUsed ?? o.run.seat.model;
    const prev = bySeat[o.run.seat.id];
    bySeat[o.run.seat.id] = { connectionId: served.connectionId, model: served.name, usd: (prev?.usd ?? 0) + o.usd };
  }
  return { usd, tokens, bySeat };
}

async function budgetBlocked(
  env: Env,
  state: RunState,
  base: ReviewBase,
  plan: Extract<BudgetPlan, { ok: false }>,
): Promise<ReviewResult> {
  const { change } = base;
  const args: Parameters<typeof renderBudgetBlockedDigest>[0] = {
    tier: base.tier,
    ceiling: ceilingPolicyName(plan.binding.ceiling),
    reason: plan.message,
  };
  if (plan.estimateUsd !== undefined) args.estimateUsd = plan.estimateUsd;
  const digest = renderBudgetBlockedDigest(args);
  await report(env, state, {
    type: "budget-blocked",
    change,
    tier: base.tier,
    reason: plan.message,
    ceiling: plan.binding.ceiling,
    digest,
  });
  // Not stored: a budget refusal is not a review, and must not consume a round or block a later re-run.
  const verdict = baseVerdict(env, base, {
    decision: "pending",
    findings: rankFindings(base.plan.knownFindings),
    reason: plan.message,
  });
  if (plan.downgrades.length > 0) verdict.downgrades = plan.downgrades;
  emit(env, "merge_safely.review.budget_blocked", 1, "count", {
    ceiling: plan.binding.ceiling,
    tier: base.tier.level,
  });
  return { verdict, digest, events: [...state.events] };
}

// ---------------------------------------------------------------------------
// Verdict commit, escalation, metrics
// ---------------------------------------------------------------------------

interface Committed {
  /** The verdict that is now the signal: the new one, or the stored one that was kept. */
  verdict: Verdict;
  digest: HumanDigest;
  contested?: boolean;
  /** True when the stored verdict was kept instead of the new one. */
  refused: boolean;
}

function result(state: RunState, c: Committed, handle?: EscalationHandle): ReviewResult {
  const r: ReviewResult = { verdict: c.verdict, digest: c.digest, events: [...state.events] };
  if (handle) r.escalation = handle;
  if (c.contested) r.contested = true;
  return r;
}

/**
 * The no-downgrade guard plus compare-and-set. A version conflict re-reads once and re-checks the guard; a second
 * conflict is a GateError("store-conflict"). When the guard refuses, the stored verdict stays the signal and is
 * reported (with a CONTESTED digest when an unresolved block prevented a pass).
 */
async function commit(
  env: Env,
  state: RunState,
  verdict: Verdict,
  opts: { reportVerdict?: boolean } = {},
): Promise<Committed> {
  const change = state.change;
  if (!change) throw new GateError("internal", "no change in scope for this verdict");
  const key: VerdictKey = { repo: verdict.repo, number: verdict.number, headSha: verdict.headSha };
  for (let i = 0; i < 2; i++) {
    const stored = await guard(env, "internal", "verdict store read failed", () => env.deps.store.get(key));
    const accept = canAcceptVerdict(stored?.verdict ?? null, verdict);
    if (!accept.ok && stored) {
      if (accept.contested) {
        verdict.contested = true;
        const signal: Verdict = { ...stored.verdict, contested: true };
        const digest = contestedDigest(env, signal, verdict, accept.reason);
        env.logger.warn("verdict contested; the stored block stands", { reason: accept.reason });
        emit(env, "merge_safely.review.contested", 1, "count", { tier: verdict.tier.level });
        await report(env, state, { type: "verdict", change, verdict: signal, digest });
        return { verdict: signal, digest, contested: true, refused: true };
      }
      env.logger.info("stored verdict kept", { reason: accept.reason });
      const digest = renderDigest(stored.verdict, { policy: env.policy });
      await report(env, state, { type: "verdict", change, verdict: stored.verdict, digest });
      return { verdict: stored.verdict, digest, refused: true };
    }
    const res = await guard(env, "internal", "verdict store write failed", () =>
      env.deps.store.put(verdict, { version: stored?.version ?? null }),
    );
    if (res.ok) {
      const digest = renderDigest(verdict, { policy: env.policy });
      if (opts.reportVerdict !== false) await report(env, state, { type: "verdict", change, verdict, digest });
      return { verdict, digest, refused: false };
    }
    env.logger.warn("verdict store compare-and-set conflict; re-reading", { headSha: verdict.headSha, attempt: i + 1 });
  }
  throw new GateError(
    "store-conflict",
    `the stored verdict for ${short(verdict.headSha)} changed concurrently twice; not overwriting it`,
  );
}

function contestedDigest(env: Env, signal: Verdict, incoming: Verdict, reason: string): HumanDigest {
  const base = renderDigest(signal, { policy: env.policy });
  const stands = `${signal.decision.toUpperCase()} stands (tier ${signal.tier.level}, round ${signal.round})`;
  const headline = `Verdict: CONTESTED — ${stands}`;
  const note = `This run (round ${incoming.round}) returned ${incoming.decision.toUpperCase()}, but ${reason}.`;
  const md = base.markdown.split("\n");
  md.splice(0, 1, `## Merge Safely: CONTESTED — ${stands}`, "", `> ${note}`);
  const text = base.text.split("\n");
  text.splice(0, 1, headline, note);
  return { headline, markdown: md.join("\n"), text: text.join("\n") };
}

async function escalate(
  env: Env,
  state: RunState,
  verdict: Verdict,
  digest: HumanDigest,
): Promise<EscalationHandle | undefined> {
  const escalation = env.deps.escalation;
  const change = state.change;
  if (!escalation || !change) return undefined;
  let handle: EscalationHandle;
  try {
    handle = await escalation.request(verdict, digest);
  } catch (err: unknown) {
    env.logger.error("escalation request failed", { error: safeText(env, err) });
    emit(env, "merge_safely.escalation.failed", 1, "count", { tier: verdict.tier.level });
    return undefined;
  }
  await report(env, state, { type: "escalated", change, verdict, digest, handle });
  return handle;
}

function emitVerdictMetrics(
  env: Env,
  base: ReviewBase,
  verdict: Verdict,
  extra: { escalated: boolean; capReached?: boolean },
): void {
  if (!env.deps.metrics) return;
  const tags = {
    tier: verdict.tier.level,
    decision: verdict.decision,
    triaged: verdict.triaged,
    trust: base.trust,
    round: verdict.round,
  };
  emit(env, "merge_safely.review.verdict", 1, "count", { ...tags, contested: verdict.contested === true });
  emit(env, "merge_safely.review.tier", verdict.tier.level, "count", tags);
  emit(env, "merge_safely.review.triaged", verdict.triaged ? 1 : 0, "count", tags);
  emit(env, "merge_safely.review.seats", verdict.seats.length, "count", tags);
  emit(env, "merge_safely.review.round", verdict.round, "count", tags);
  emit(env, "merge_safely.review.time_to_verdict_ms", env.clock.now().getTime() - base.startedMs, "ms", tags);
  const byConn = new Map<string, number>();
  for (const s of Object.values(verdict.cost.bySeat)) {
    byConn.set(s.connectionId, (byConn.get(s.connectionId) ?? 0) + (s.usd ?? 0));
  }
  for (const [connection, usd] of [...byConn.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    emit(env, "merge_safely.review.cost_usd", usd, "usd", { ...tags, connection });
  }
  const findingCounts = new Map<string, { severity: string; cls: string; n: number }>();
  for (const f of verdict.findings) {
    const k = `${f.severity}\u0000${f.class}`;
    const prev = findingCounts.get(k) ?? { severity: f.severity, cls: f.class, n: 0 };
    prev.n++;
    findingCounts.set(k, prev);
  }
  for (const { severity, cls, n } of findingCounts.values()) {
    emit(env, "merge_safely.review.findings", n, "count", { ...tags, severity, class: cls });
  }
  if (verdict.addressed) emit(env, "merge_safely.rounds.addressed", verdict.addressed.length, "count", tags);
  if (verdict.carried) emit(env, "merge_safely.rounds.carried", verdict.carried.length, "count", tags);
  if (extra.escalated) {
    emit(env, "merge_safely.review.escalations", 1, "count", { ...tags, capReached: extra.capReached === true });
  }
  if (verdict.downgrades && verdict.downgrades.length > 0) {
    emit(env, "merge_safely.review.downgrades", verdict.downgrades.length, "count", tags);
  }
}

// ---------------------------------------------------------------------------
// estimate, explain, human verdicts
// ---------------------------------------------------------------------------

function isChange(target: ChangeRef | Change): target is Change {
  return "headSha" in target && typeof target.headSha === "string";
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

async function estimate(env: Env, target: ChangeRef | Change): Promise<Estimate> {
  const { policy } = env;
  let raw: Change;
  if (isChange(target)) {
    raw = target;
  } else {
    const source = requireSource(env, "estimate() of a change reference");
    raw = await guard(env, "source", "could not load the change", () => source.getChange(target));
  }
  const { change } = intake(raw, {}, policy);
  const t = tierOf(change, policy);
  const tri = triage(change, t, policy);
  const prior = await guard(env, "internal", "verdict store unavailable", () =>
    env.deps.store.listForChange(change.repo, change.number),
  );
  const plan = planRound({ change, priorVerdicts: prior, policy });
  const autoPassed = tri.decision === "auto-pass" && !plan.knownFindings.some(serious);
  let seats: Seat[] = [];
  let secondJudgeRound = false;
  if (!plan.capReached && !autoPassed) {
    try {
      const s = seat({
        tier: t,
        change,
        policy,
        connections: env.deps.connections,
        catalog: (id) => catalogOf(env, id),
        normalise: env.normalise,
      });
      seats = s.seats;
      secondJudgeRound = s.secondJudgeRound;
    } catch (err: unknown) {
      if (err instanceof SeatingError) throw new GateError("seating", safeText(env, err), { fix: err.fix });
      throw new GateError("internal", safeText(env, err));
    }
  }
  const estimator = seatEstimator(env, change, estimateDiffChars(change), secondJudgeRound);
  const est = estimatePanel(seats, estimator);
  const spend = await spendInputs(env, change, scopeIdFor(env, change));
  const ceilings = evaluateCeilings({
    policy,
    ...spend,
    advisory: env.deps.advisoryCeilings ?? [],
    seatEstimates: seats.map((s) => {
      const usd = estimator(s);
      return usd === undefined ? { seatId: s.id } : { seatId: s.id, usd };
    }),
  });

  const lines: string[] = [
    `Change ${change.repo.owner}/${change.repo.name}#${change.number} @ ${short(change.headSha)}: tier ${t.level} (score ${t.score})`,
    ...t.reasons.map((r) => `  ${redactText(r)}`),
    `Round ${plan.round} of ${policy.rounds.max}${plan.diffOnly && plan.sinceSha ? ` (diff-only since ${short(plan.sinceSha)})` : ""}`,
  ];
  if (plan.capReached) {
    lines.push(
      `Round cap reached (policy.rounds.max = ${policy.rounds.max}): the next review escalates to a human without seating a panel.`,
    );
  } else if (autoPassed) {
    lines.push(`Triage: auto-pass (${tri.reason}); no seats.`);
  } else {
    lines.push(describeSeating(seats, estimator));
    if (secondJudgeRound) lines.push("Second judge round on split votes is enabled (included in the judge estimates).");
  }
  const unpriced = est.unknownSeats.length > 0 ? ` (unpriced: ${est.unknownSeats.join(", ")})` : "";
  lines.push(
    `Estimated cost: ${est.usd !== undefined ? fmtUsd(est.usd) : "unknown"} for ${seats.length} seat${seats.length === 1 ? "" : "s"}${unpriced}`,
  );
  for (const c of ceilings.filter((r) => r.breached)) {
    lines.push(`${c.advisory ? "Advisory: " : "Over budget: "}${ceilingMessage(c, policy)}`);
  }

  const out: Estimate = {
    change,
    tier: t,
    triage: tri,
    seats,
    secondJudgeRound,
    unknownSeats: est.unknownSeats,
    ceilings,
    round: plan.round,
    diffOnly: plan.diffOnly,
    summary: lines.join("\n"),
  };
  if (est.usd !== undefined) out.estimateUsd = est.usd;
  return out;
}

async function explain(
  env: Env,
  ref: ChangeRef,
): Promise<{ verdict: Verdict | null; digest: HumanDigest | null; history: Verdict[] }> {
  const source = requireSource(env, "explain()");
  const change = await guard(env, "source", "could not load the change", () => source.getChange(ref));
  const stored = await guard(env, "internal", "verdict store read failed", () =>
    env.deps.store.get({ repo: change.repo, number: change.number, headSha: change.headSha }),
  );
  const history = await guard(env, "internal", "verdict store read failed", () =>
    env.deps.store.listForChange(change.repo, change.number),
  );
  const verdict = stored?.verdict ?? null;
  return { verdict, digest: verdict ? renderDigest(verdict, { policy: env.policy }) : null, history };
}

const NO_TIER: Tier = {
  level: 0,
  score: 0,
  factors: { loc: 0, files: 0, modules: 0, criticalPathHits: [] },
  reasons: ["no machine verdict is recorded for this commit"],
};

async function recordHumanVerdict(env: Env, input: HumanVerdictInput): Promise<Verdict> {
  const state = new RunState();
  const { ref, headSha } = input;
  try {
    const history = await guard(env, "internal", "verdict store unavailable", () =>
      env.deps.store.listForChange(ref.repo, ref.number),
    );
    const machine = history
      .filter((v) => v.kind === "machine" && v.headSha === headSha)
      .sort((a, b) => a.round - b.round);
    const latest = machine[machine.length - 1];
    const round = latest?.round ?? Math.max(0, ...history.map((v) => v.round));
    let change: Change | undefined;
    const source = env.deps.source;
    if (source) {
      try {
        change = await source.getChange(ref);
      } catch (err: unknown) {
        env.logger.warn("could not load the change for the human verdict report", { error: safeText(env, err) });
      }
    }
    state.change = { ...(change ? intake(change, {}, env.policy).change : placeholderChange(input)), headSha };
    state.round = round;
    const verdict: Verdict = {
      repo: ref.repo,
      number: ref.number,
      headSha,
      kind: "human",
      decision: input.decision,
      tier: latest?.tier ?? NO_TIER,
      round,
      triaged: false,
      seats: [],
      findings: input.decision === "block" ? rankFindings(openFindings(history)) : [],
      quorum: { required: 0, passed: 0, blocked: 0, invalid: 0 },
      cost: { usd: 0, tokens: { in: 0, out: 0 }, bySeat: {} },
      signedBy: input.signedBy,
      reason: redactText(input.reason),
      createdAt: nowIso(env),
      policyHash: env.policyHash,
      producedBy: env.producedBy,
    };
    const committed = await commit(env, state, verdict);
    emit(env, "merge_safely.human_verdict", 1, "count", { decision: input.decision, tier: verdict.tier.level });
    return committed.verdict;
  } catch (err: unknown) {
    throw await fail(env, state, err);
  }
}

function placeholderChange(input: HumanVerdictInput): Change {
  return {
    repo: input.ref.repo,
    number: input.ref.number,
    headSha: input.headSha,
    baseSha: "",
    baseRef: "",
    headRef: "",
    title: "",
    body: "",
    author: input.signedBy,
    files: [],
    stats: { additions: 0, deletions: 0, files: 0 },
    labels: [],
    draft: false,
    ciStatus: "unknown",
  };
}
