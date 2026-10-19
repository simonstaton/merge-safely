/**
 * Circuit-breaker hook (design section 10). Pure: reads an eval result and returns suggestions. It never mutates a
 * policy; a human (or a reviewed PR) applies the suggestion.
 *
 * - False-block rate on known-clean cases above the threshold: suggest widening triage (the panel is spending
 *   reviews and blocking changes that evidence says are fine).
 * - Incident recall below the threshold at a tier (the tier the gate actually assigned): suggest raising that tier's
 *   quorum. When the missed incidents never reached a reviewer because triage auto-passed them, quorum cannot help,
 *   so suggest narrowing triage. Incidents tiered below their expected tier get a separate "fix tiering" suggestion:
 *   raising quorum at the wrong tier would not have caught them.
 */
import type { TierLevel } from "@merge-safely/core";
import type { SuiteResult } from "./types.js";

export interface BreakerPolicy {
  /** Highest acceptable false-block rate on clean cases. */
  maxFalseBlock: number;
  /** Lowest acceptable incident recall within any tier. */
  minRecall: number;
  /** Ignore tiers with fewer incident cases than this (too little evidence). Default 1. */
  minIncidentsPerTier?: number;
}

export interface BreakerSuggestions {
  widenTriage?: boolean;
  /** The highest tier whose incident recall is below threshold. */
  raiseQuorumTier?: TierLevel;
  /** Every tier below threshold, highest first. */
  raiseQuorumTiers?: TierLevel[];
  narrowTriage?: boolean;
  /** Incident cases that landed below their expected tier: add a critical path or tiering rule, not quorum. */
  fixTiering?: string[];
  reasons: string[];
}

const pct = (n: number): string => `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`;

export function evaluateBreakers(result: SuiteResult, policy?: Partial<BreakerPolicy>): BreakerSuggestions {
  const s = result.summary;
  const p: BreakerPolicy = {
    maxFalseBlock: policy?.maxFalseBlock ?? s.gates.maxFalseBlock,
    minRecall: policy?.minRecall ?? s.gates.minRecall,
    minIncidentsPerTier: policy?.minIncidentsPerTier ?? 1,
  };
  const out: BreakerSuggestions = { reasons: [] };
  if (s.dry) {
    out.reasons.push("dry run: no review outcomes, breakers not evaluated");
    return out;
  }

  if (s.falseBlockRate !== null && s.falseBlockRate > p.maxFalseBlock) {
    out.widenTriage = true;
    const blocked = result.cases
      .filter((c) => c.kind === "clean" && c.actual.decision === "block")
      .map((c) => `${c.id} (tier ${c.actual.tier ?? "?"})`);
    out.reasons.push(
      `false-block rate ${pct(s.falseBlockRate)} on ${s.clean} clean case(s) exceeds ${pct(p.maxFalseBlock)}: widen triage (triage.maxLines / maxFiles or patterns) and review the blocking lenses; blocked: ${blocked.join(", ")}`,
    );
  }

  const underTiered = result.cases
    .filter(
      (c) =>
        c.kind === "incident" &&
        c.expected.tier !== undefined &&
        c.actual.tier !== undefined &&
        c.actual.tier < c.expected.tier,
    )
    .map((c) => `${c.id} (expected tier ${c.expected.tier}, got ${c.actual.tier})`);
  if (underTiered.length > 0) {
    out.fixTiering = underTiered;
    out.reasons.push(
      `${underTiered.length} incident(s) tiered too low: add a critical path or tiering rule (raising quorum at the assigned tier would not target them): ${underTiered.join(", ")}`,
    );
  }

  const failing: TierLevel[] = [];
  for (const level of [3, 2, 1, 0] as const) {
    const t = s.perTier[`${level}`];
    if (!t || t.recall === null || t.incidents < (p.minIncidentsPerTier ?? 1)) continue;
    if (t.recall >= p.minRecall) continue;
    const missed = t.incidents - t.blocked;
    if (t.missedByTriage > 0) {
      out.narrowTriage = true;
      out.reasons.push(
        `tier ${level}: ${t.missedByTriage} missed incident(s) were auto-passed by triage and never reviewed: narrow triage or add a critical path`,
      );
    }
    if (missed > t.missedByTriage) {
      failing.push(level);
      out.reasons.push(
        `tier ${level}: incident recall ${pct(t.recall)} (${t.blocked}/${t.incidents}) is below ${pct(p.minRecall)}: raise quorum.t${Math.max(1, level)} until reviewed`,
      );
    }
  }
  if (failing.length > 0) {
    out.raiseQuorumTiers = failing;
    out.raiseQuorumTier = failing[0];
  }
  if (out.reasons.length === 0) out.reasons.push("all breakers within thresholds");
  return out;
}
