/**
 * The orchestrator (design 4.2, 4.3): wires the pure stages to the ports.
 *
 *   review: getChange -> pin head -> intake -> tier -> rounds plan -> pending -> trust -> [cap: escalate]
 *           -> triage [auto-pass] -> diff -> seat -> budget [downgrade | budget-blocked] -> hunters
 *           -> attest + fingerprint + redact -> judges (+ second round on split votes) -> judge votes
 *           -> reconcile rounds -> aggregate -> verdict -> no-downgrade guard + CAS -> digest -> report
 *           -> escalate -> metrics
 *
 * Every port call is wrapped and time-bounded: once a change is known, any failure reports an `error` event and rejects
 * with a GateError whose message is secret-scrubbed. Reporters, metrics, ledger appends and escalation never fail a
 * review. A run that cannot decide (pending) never replaces a decided verdict stored for the same SHA.
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
import {
  type BudgetPlan,
  ceilingPolicyName,
  fallbackFits,
  overContextSeats,
  planBudget,
  scopeIdFor,
  seatEstimator,
  spendInputs,
} from "./budget.js";
import {
  catalogOf,
  type Env,
  emit,
  fail,
  guard,
  makeEnv,
  nowIso,
  RunState,
  report,
  safeText,
  withTimeout,
} from "./env.js";
import { GateError } from "./errors.js";
import { mapLimit } from "./limit.js";
import { type RoundContext, runSeat, type SeatOutcome, sanitiseRun } from "./seats.js";
import type {
  Estimate,
  Gate,
  GateDeps,
  HumanVerdictInput,
  ReviewChangeContext,
  ReviewChangeOptions,
  ReviewResult,
} from "./types.js";
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
  const change = await guard(
    env,
    "source",
    "could not load the change",
    () => source.getChange(ref),
    env.timeouts.sourceMs,
  );
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
      const getContext = source.getUntrustedContext.bind(source);
      ctx = await withTimeout(getContext(ref), env.timeouts.sourceMs, "loading commit messages and comments");
    } catch (err: unknown) {
      env.logger.warn("could not load commit messages and comments; reviewing without them", {
        error: safeText(env, err),
      });
    }
  }
  const ms = env.timeouts.sourceMs;
  const diffs: DiffSource = {
    full: () => guard(env, "source", "could not fetch the diff", () => source.getDiff(ref, { headSha }), ms),
    delta: (sinceSha) =>
      guard(env, "source", "could not fetch the delta diff", () => source.getDiff(ref, { sinceSha, headSha }), ms),
  };
  return pipeline(env, state, change, ctx, diffs, opts.trigger, { persist: true, allowDirty: false });
}

async function reviewChange(
  env: Env,
  change: Change,
  ctx: ReviewChangeContext,
  opts: ReviewChangeOptions,
): Promise<ReviewResult> {
  const state = new RunState();
  const diffs: DiffSource = { full: async () => ctx.diff };
  const delta = ctx.deltaDiff;
  if (delta !== undefined) diffs.delta = async () => delta;
  const mode: Mode = { persist: opts.persist === true, allowDirty: true };
  return pipeline(env, state, change, ctx.untrusted ?? {}, diffs, opts.trigger, mode);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** review(): persist, clean checkout required. reviewChange(): persist only on request, dirty tree allowed. */
interface Mode {
  persist: boolean;
  allowDirty: boolean;
}

interface ReviewBase {
  mode: Mode;
  change: Change;
  tier: Tier;
  plan: RoundPlan;
  prior: Verdict[];
  /** The verdict stored for this SHA when the run started (the store has one slot per SHA). */
  priorSame?: Verdict;
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
  mode: Mode,
): Promise<ReviewResult> {
  const startedMs = env.clock.now().getTime();
  try {
    const { policy } = env;
    const { change, untrusted } = intake(raw, ictx, policy);
    state.change = change;
    const t = tierOf(change, policy);
    const prior = await guard(
      env,
      "internal",
      "verdict store unavailable",
      () => env.deps.store.listForChange(change.repo, change.number),
      env.timeouts.storeMs,
    );
    const plan = planRound({ change, priorVerdicts: prior, policy });
    state.round = plan.round;
    const pending: ReportEvent = { type: "pending", change, tier: t, round: plan.round };
    if (trigger) pending.message = `Review triggered by ${redactText(trigger).slice(0, 200)}`;
    await report(env, state, pending);

    const trust = await classifyTrust(env, change);
    const bypass = trust === "trusted" && t.level <= policy.trust.trustedBypassMaxTier;
    const base: ReviewBase = { mode, change, tier: t, plan, prior, trust, bypass, startedMs };
    const same = prior.filter((v) => v.headSha === change.headSha).sort((a, b) => a.round - b.round);
    const priorSame = same[same.length - 1];
    if (priorSame) base.priorSame = priorSame;

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
    cls = await withTimeout(
      Promise.resolve().then(() => trust.classify(change.author, change.repo)),
      env.timeouts.trustMs,
      "trust lookup",
    );
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

/** Escalation already recorded on this SHA's stored verdict: never request again for it. */
function priorEscalation(base: ReviewBase): Pick<Verdict, "escalated" | "escalation"> | undefined {
  const v = base.priorSame;
  if (!v || !(v.escalated || v.escalation)) return undefined;
  const out: Pick<Verdict, "escalated" | "escalation"> = { escalated: true };
  if (v.escalation) out.escalation = v.escalation;
  return out;
}

async function capReached(env: Env, state: RunState, base: ReviewBase): Promise<ReviewResult> {
  const { plan, change, mode } = base;
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
    reason: `round cap reached (policy.rounds.max = ${env.policy.rounds.max}); no panel seated, a human must sign off`,
  });
  if (known.length > 0) verdict.carried = known.map((f) => f.id);
  const already = priorEscalation(base);
  if (already) Object.assign(verdict, already);
  const willRequest = mode.persist && env.deps.escalation !== undefined && !already;
  let committed = await commit(env, state, verdict, { persist: mode.persist, reportVerdict: !willRequest });
  let handle: EscalationHandle | undefined;
  if (!committed.refused && willRequest) {
    const esc = await escalate(env, state, committed.verdict, mode);
    if (esc) {
      handle = esc.handle;
      committed = { ...committed, verdict: esc.verdict, digest: esc.digest };
    } else {
      await report(env, state, { type: "verdict", change, verdict: committed.verdict, digest: committed.digest });
    }
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
  const committed = await commit(env, state, verdict, { persist: base.mode.persist });
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
  const spend = await spendInputs(env, change, scopeId, base.prior);
  const estimate = seatEstimator(env, change, diff.length, seating.secondJudgeRound);
  const budget = planBudget(env, { seats: seating.seats, tier: t, spend, estimate });
  if (!budget.ok) return budgetBlocked(env, state, base, budget);
  const seats = budget.seats;
  for (const id of overContextSeats(env, seats, diff.length)) {
    env.logger.warn("the diff alone exceeds this seat's model context window; the seat will likely fail", {
      seatId: id,
    });
  }

  const rc: RoundContext = {
    change,
    tier: t,
    round: plan.round,
    diff,
    diffIsDelta,
    untrusted,
    knownFindings: plan.knownFindings,
    scopeId,
    allowDirty: base.mode.allowDirty,
    persist: base.mode.persist,
    fallbackFits: (original, fallback, spentUsd) =>
      fallbackFits(env, { spend, panelUsd: budget.estimateUsd, estimate, original, fallback, spentUsd }),
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

  // Every hunter produced nothing usable: an outage, reported as an error event alongside the verdict.
  const allFailed = hunterRuns.length > 0 && hunterRuns.every((r) => r.output === null);
  let outage: string | undefined;
  if (allFailed) {
    const list = hunterRuns.map((r) => `${r.seat.id} (${r.status}${r.error ? `: ${r.error}` : ""})`).join("; ");
    outage = safeText(env, `all ${hunterRuns.length} reviewer seats failed: ${list}`, 2_000);
  }

  const tier3Rule =
    t.level === 3 &&
    base.trust !== "trusted" &&
    policy.trust.escalateTier3ForStandardAuthors &&
    agg.decision === "block";
  const pendingRule = agg.decision === "pending";
  const blockedAuthor = base.trust === "blocked" && agg.decision !== "pass";
  const shouldEscalate = !base.bypass && (tier3Rule || pendingRule || blockedAuthor);
  const already = shouldEscalate ? priorEscalation(base) : undefined;
  if (already) Object.assign(verdict, already);
  const willRequest = shouldEscalate && base.mode.persist && env.deps.escalation !== undefined && !already;

  const commitOpts: CommitOptions = { persist: base.mode.persist };
  if (outage) commitOpts.outage = outage;
  let committed = await commit(env, state, verdict, commitOpts);
  let handle: EscalationHandle | undefined;
  if (!committed.refused && willRequest) {
    const esc = await escalate(env, state, committed.verdict, base.mode);
    if (esc) {
      handle = esc.handle;
      committed = { ...committed, verdict: esc.verdict, digest: esc.digest };
    }
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
  if (base.mode.persist) {
    const stored = await storeGet(env, verdict);
    if (stored && stored.verdict.decision !== "pending") {
      // A decided verdict for this SHA stays the signal; re-report it so the check leaves the pending state.
      const storedDigest = renderDigest(stored.verdict, { policy: env.policy });
      await report(env, state, { type: "verdict", change, verdict: stored.verdict, digest: storedDigest });
      return { verdict: stored.verdict, digest: storedDigest, events: [...state.events], pendingReason: plan.message };
    }
  }
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
  /** Why this run did not decide, when a decided stored verdict was kept instead. */
  pendingReason?: string;
}

interface CommitOptions {
  /** False: render and report only, never touch the store. */
  persist: boolean;
  /** Default true. False when the caller reports the outcome itself (escalated event). */
  reportVerdict?: boolean;
  /** An outage description, reported as an error event alongside the verdict. */
  outage?: string;
}

function result(state: RunState, c: Committed, handle?: EscalationHandle): ReviewResult {
  const r: ReviewResult = { verdict: c.verdict, digest: c.digest, events: [...state.events] };
  if (handle) r.escalation = handle;
  if (c.contested) r.contested = true;
  if (c.pendingReason) r.pendingReason = c.pendingReason;
  return r;
}

const keyOf = (v: VerdictKey): VerdictKey => ({ repo: v.repo, number: v.number, headSha: v.headSha });

function storeGet(env: Env, key: VerdictKey): Promise<{ verdict: Verdict; version: string } | null> {
  return guard(env, "internal", "verdict store read", () => env.deps.store.get(keyOf(key)), env.timeouts.storeMs);
}

function storePut(env: Env, v: Verdict, version: string | null): Promise<{ ok: boolean; version: string }> {
  return guard(env, "internal", "verdict store write", () => env.deps.store.put(v, { version }), env.timeouts.storeMs);
}

/**
 * The no-downgrade guards plus compare-and-set.
 * - A machine `pending` (outage, too few valid seats) never replaces a decided verdict stored for the same SHA: the
 *   stored verdict stays the signal, is re-reported, and the run's failure goes out as an error event.
 * - `canAcceptVerdict` refusals keep the stored verdict too (CONTESTED digest when an unresolved block refused a pass).
 * - A version conflict re-reads once and re-checks both guards; a second conflict is GateError("store-conflict").
 * With `persist: false` the store is never touched: the verdict is rendered and reported only.
 */
async function commit(env: Env, state: RunState, verdict: Verdict, opts: CommitOptions): Promise<Committed> {
  const change = state.change;
  if (!change) throw new GateError("internal", "no change in scope for this verdict");
  const reportOutage = async (message: string): Promise<void> => {
    await report(env, state, { type: "error", change, error: message, round: verdict.round });
  };
  if (!opts.persist) {
    if (opts.outage) await reportOutage(opts.outage);
    const digest = renderDigest(verdict, { policy: env.policy });
    if (opts.reportVerdict !== false) await report(env, state, { type: "verdict", change, verdict, digest });
    return { verdict, digest, refused: false };
  }
  for (let i = 0; i < 2; i++) {
    const stored = await storeGet(env, verdict);
    if (
      stored &&
      verdict.kind === "machine" &&
      verdict.decision === "pending" &&
      stored.verdict.decision !== "pending"
    ) {
      const why = opts.outage ?? verdict.reason ?? "this run could not reach a decision";
      const kept = `${stored.verdict.decision.toUpperCase()} (${stored.verdict.kind}, round ${stored.verdict.round})`;
      env.logger.warn("run ended pending; keeping the decided verdict stored for this SHA", { kept });
      await reportOutage(
        safeText(env, `${why}. The stored ${kept} verdict for ${short(verdict.headSha)} stands.`, 2_000),
      );
      const digest = renderDigest(stored.verdict, { policy: env.policy });
      await report(env, state, { type: "verdict", change, verdict: stored.verdict, digest });
      return { verdict: stored.verdict, digest, refused: true, pendingReason: why };
    }
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
    const res = await storePut(env, verdict, stored?.version ?? null);
    if (res.ok) {
      if (opts.outage) await reportOutage(opts.outage);
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

/**
 * Request a human sign-off. Only after `request` succeeds is the verdict marked `escalated` with its handle, and the
 * stored copy updated (CAS, only while it is still this verdict), so a re-run never escalates the same SHA twice.
 * A failing or hanging request is logged and returns undefined.
 */
async function escalate(
  env: Env,
  state: RunState,
  verdict: Verdict,
  mode: Mode,
): Promise<{ handle: EscalationHandle; verdict: Verdict; digest: HumanDigest } | undefined> {
  const escalation = env.deps.escalation;
  const change = state.change;
  if (!escalation || !change) return undefined;
  let handle: EscalationHandle;
  try {
    const asked: Verdict = { ...verdict, escalated: true };
    const askedDigest = renderDigest(asked, { policy: env.policy });
    handle = await withTimeout(
      Promise.resolve().then(() => escalation.request(asked, askedDigest)),
      env.timeouts.escalationMs,
      "escalation request",
    );
  } catch (err: unknown) {
    env.logger.error("escalation request failed", { error: safeText(env, err) });
    emit(env, "merge_safely.escalation.failed", 1, "count", { tier: verdict.tier.level });
    return undefined;
  }
  const updated: Verdict = { ...verdict, escalated: true, escalation: handle };
  if (mode.persist) {
    try {
      const stored = await storeGet(env, verdict);
      if (stored && stored.verdict.createdAt === verdict.createdAt && stored.verdict.round === verdict.round) {
        const res = await storePut(env, updated, stored.version);
        if (!res.ok) env.logger.warn("could not record the escalation on the stored verdict (concurrent write)");
      }
    } catch (err: unknown) {
      env.logger.error("could not record the escalation on the stored verdict", { error: safeText(env, err) });
    }
  }
  const digest = renderDigest(updated, { policy: env.policy });
  await report(env, state, { type: "escalated", change, verdict: updated, digest, handle });
  return { handle, verdict: updated, digest };
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

/**
 * What review() would do, without any model call or report: the same tier, triage, round plan, seating, spend
 * inputs, admission and downgrade ladder. When the target is a reference and a source exists, the real diff (the
 * delta on diff-only rounds) sizes the estimate, as in review(); otherwise the change stats do.
 */
async function estimate(env: Env, target: ChangeRef | Change): Promise<Estimate> {
  const { policy } = env;
  const source = env.deps.source;
  let raw: Change;
  if (isChange(target)) {
    raw = target;
  } else {
    const s = requireSource(env, "estimate() of a change reference");
    raw = await guard(env, "source", "could not load the change", () => s.getChange(target), env.timeouts.sourceMs);
  }
  const { change } = intake(raw, {}, policy);
  const t = tierOf(change, policy);
  const tri = triage(change, t, policy);
  const prior = await guard(
    env,
    "internal",
    "verdict store unavailable",
    () => env.deps.store.listForChange(change.repo, change.number),
    env.timeouts.storeMs,
  );
  const plan = planRound({ change, priorVerdicts: prior, policy });
  const autoPassed = tri.decision === "auto-pass" && !plan.knownFindings.some(serious);
  let seated: Seat[] = [];
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
      seated = s.seats;
      secondJudgeRound = s.secondJudgeRound;
    } catch (err: unknown) {
      if (err instanceof SeatingError) throw new GateError("seating", safeText(env, err), { fix: err.fix });
      throw new GateError("internal", safeText(env, err));
    }
  }

  let diffChars = estimateDiffChars(change);
  if (!isChange(target) && source && seated.length > 0) {
    const ref = target;
    const opts =
      plan.diffOnly && plan.sinceSha
        ? { sinceSha: plan.sinceSha, headSha: change.headSha }
        : { headSha: change.headSha };
    try {
      const diff = await withTimeout(
        Promise.resolve().then(() => source.getDiff(ref, opts)),
        env.timeouts.sourceMs,
        "fetching the diff",
      );
      diffChars = redactDiff(diff, policy).length;
    } catch (err: unknown) {
      env.logger.warn("could not fetch the diff; estimating from change stats", { error: safeText(env, err) });
    }
  }
  const estimator = seatEstimator(env, change, diffChars, secondJudgeRound);
  const spend = await spendInputs(env, change, scopeIdFor(env, change), prior);

  let seats = seated;
  let ceilings: Estimate["ceilings"];
  let budget: BudgetPlan | undefined;
  if (seated.length > 0) {
    budget = planBudget(env, { seats: seated, tier: t, spend, estimate: estimator });
    if (budget.ok) seats = budget.seats;
    ceilings = budget.results;
  } else {
    ceilings = evaluateCeilings({ policy, ...spend, advisory: env.deps.advisoryCeilings ?? [], seatEstimates: [] });
  }
  const est = estimatePanel(seats, estimator);
  const unknownSeats = [...new Set([...est.unknownSeats, ...overContextSeats(env, seats, diffChars)])];

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
  for (const d of budget?.downgrades ?? []) {
    if (d.step !== "block")
      lines.push(`Downgrade: ${d.step}${d.from || d.to ? ` (${d.from ?? "?"} → ${d.to ?? "?"})` : ""}`);
  }
  const unreliable = unknownSeats.length > 0 ? ` (estimate unreliable for: ${unknownSeats.join(", ")})` : "";
  lines.push(
    `Estimated cost: ${est.usd !== undefined ? fmtUsd(est.usd) : "unknown"} for ${seats.length} seat${seats.length === 1 ? "" : "s"}${unreliable}`,
  );
  if (budget && !budget.ok) lines.push(`Budget: review would be refused. ${budget.message}`);
  for (const c of ceilings.filter((r) => r.breached && r.advisory))
    lines.push(`Advisory: ${ceilingMessage(c, policy)}`);

  const out: Estimate = {
    change,
    tier: t,
    triage: tri,
    seats,
    secondJudgeRound,
    unknownSeats,
    ceilings,
    round: plan.round,
    diffOnly: plan.diffOnly,
    summary: lines.join("\n"),
  };
  if (est.usd !== undefined) out.estimateUsd = est.usd;
  if (budget && budget.downgrades.length > 0) out.downgrades = budget.downgrades;
  if (budget && !budget.ok) out.budgetBlocked = { ceiling: budget.binding.ceiling, message: budget.message };
  return out;
}

async function explain(
  env: Env,
  ref: ChangeRef,
): Promise<{ verdict: Verdict | null; digest: HumanDigest | null; history: Verdict[] }> {
  const source = requireSource(env, "explain()");
  const change = await guard(
    env,
    "source",
    "could not load the change",
    () => source.getChange(ref),
    env.timeouts.sourceMs,
  );
  const stored = await storeGet(env, { repo: change.repo, number: change.number, headSha: change.headSha });
  const history = await guard(
    env,
    "internal",
    "verdict store read failed",
    () => env.deps.store.listForChange(change.repo, change.number),
    env.timeouts.storeMs,
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
    const history = await guard(
      env,
      "internal",
      "verdict store unavailable",
      () => env.deps.store.listForChange(ref.repo, ref.number),
      env.timeouts.storeMs,
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
        change = await withTimeout(
          Promise.resolve().then(() => source.getChange(ref)),
          env.timeouts.sourceMs,
          "loading the change",
        );
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
    const committed = await commit(env, state, verdict, { persist: true });
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
