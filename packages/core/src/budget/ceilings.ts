/**
 * Budget ceilings and admission (design 4.2 step 5, 7.6).
 *
 * Five ceilings are evaluated against a proposed panel before anything runs:
 *   per-seat   budget.perSeatUsd                  one reviewer run
 *   per-change budget.perChangeUsd                one PR across all rounds (spent so far + panel estimate)
 *   window     budget.windowUsd                   installation, rolling window of budget.windowDays
 *   all-time   budget.spendLimitUsd               installation, against the gate's own ledger
 *   monthly    budget.perInstallationMonthlyUsd   installation, calendar month (advisory in the Action)
 *
 * Limit semantics: `null`/`undefined` = never configured (unset), `0` = explicitly disabled. Neither ever breaches.
 * A ceiling breaches only when the projected spend strictly exceeds the limit, so a zero-cost panel never trips a
 * ceiling that spend already sits on.
 */
import type { Policy } from "../policy/schema.js";
import { formatUsd as usd } from "./format.js";

export type CeilingKind = "per-seat" | "per-change" | "window" | "all-time" | "monthly";

export interface CeilingResult {
  ceiling: CeilingKind;
  limitUsd: number | null;
  currentUsd: number;
  projectedUsd: number;
  breached: boolean;
  /** projected / limit; 0 when the ceiling is unset or disabled. */
  fraction: number;
  seatId?: string;
}

export interface CeilingInput {
  policy: Policy;
  seatEstimates: { seatId: string; usd?: number }[];
  /** Spent so far on this change across all rounds (CostLedger.forChange). */
  changeSpendUsd: number;
  windowSpendUsd?: number;
  allTimeSpendUsd?: number;
  monthlySpendUsd?: number;
}

/** The policy key a user raises to lift each ceiling. */
export const CEILING_POLICY_KEYS: Record<CeilingKind, string> = {
  "per-seat": "budget.perSeatUsd",
  "per-change": "budget.perChangeUsd",
  window: "budget.windowUsd",
  "all-time": "budget.spendLimitUsd",
  monthly: "budget.perInstallationMonthlyUsd",
};

/** Installation-wide ceilings refuse new reviews at admission; a cheaper panel does not help the next PR. */
export function isInstallationCeiling(c: CeilingKind): boolean {
  return c === "window" || c === "all-time" || c === "monthly";
}

const EPSILON = 1e-9;

/** null/undefined/0/negative/non-finite all mean "no enforced limit". */
export function effectiveCeilingLimit(limit: number | null | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;
}

function result(
  ceiling: CeilingKind,
  rawLimit: number | null | undefined,
  currentUsd: number,
  addUsd: number,
  seatId?: string,
): CeilingResult {
  const limitUsd = effectiveCeilingLimit(rawLimit);
  const projectedUsd = currentUsd + addUsd;
  const r: CeilingResult = {
    ceiling,
    limitUsd,
    currentUsd,
    projectedUsd,
    breached: limitUsd !== null && projectedUsd > limitUsd + EPSILON,
    fraction: limitUsd === null ? 0 : projectedUsd / limitUsd,
  };
  if (seatId !== undefined) r.seatId = seatId;
  return r;
}

function money(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

export function evaluateCeilings(input: CeilingInput): CeilingResult[] {
  const b = input.policy.budget;
  const panelUsd = input.seatEstimates.reduce((s, e) => s + money(e.usd), 0);
  const out: CeilingResult[] = input.seatEstimates.map((e) =>
    result("per-seat", b.perSeatUsd, 0, money(e.usd), e.seatId),
  );
  out.push(result("per-change", b.perChangeUsd, money(input.changeSpendUsd), panelUsd));
  out.push(result("window", b.windowUsd, money(input.windowSpendUsd), panelUsd));
  out.push(result("all-time", b.spendLimitUsd, money(input.allTimeSpendUsd), panelUsd));
  out.push(result("monthly", b.perInstallationMonthlyUsd, money(input.monthlySpendUsd), panelUsd));
  return out;
}

export type AdmitResult =
  | { ok: true; results: CeilingResult[] }
  | { ok: false; binding: CeilingResult; results: CeilingResult[]; message: string };

/** Precedence for the binding ceiling: installation-wide first (they refuse outright), then per-change, per-seat. */
const PRECEDENCE: CeilingKind[] = ["all-time", "window", "monthly", "per-change", "per-seat"];

/**
 * Admission check. When any ceiling breaches, the binding one is the highest-precedence breach (highest fraction
 * within a kind) and the message names it and the policy key to raise.
 */
export function admit(input: CeilingInput): AdmitResult {
  const results = evaluateCeilings(input);
  const breached = results.filter((r) => r.breached);
  if (breached.length === 0) return { ok: true, results };
  breached.sort((a, b) => PRECEDENCE.indexOf(a.ceiling) - PRECEDENCE.indexOf(b.ceiling) || b.fraction - a.fraction);
  const binding = breached[0] as CeilingResult;
  return { ok: false, binding, results, message: ceilingMessage(binding, input.policy) };
}

export function ceilingMessage(r: CeilingResult, policy?: Policy): string {
  const key = CEILING_POLICY_KEYS[r.ceiling];
  const limit = usd(r.limitUsd ?? 0);
  const what =
    r.ceiling === "per-seat"
      ? `seat ${r.seatId ?? "?"} is estimated at ${usd(r.projectedUsd)}`
      : `projected spend ${usd(r.projectedUsd)} (${usd(r.currentUsd)} already spent + ${usd(r.projectedUsd - r.currentUsd)} for this panel)`;
  const scope = r.ceiling === "window" && policy ? ` over the last ${policy.budget.windowDays} day(s)` : "";
  const reset = isInstallationCeiling(r.ceiling) ? ", or reset the gate's spend ledger" : "";
  return `Budget ceiling "${r.ceiling}" would be exceeded: ${what}${scope} against a limit of ${limit}. Raise ${key} in .merge-safely.yml${reset}, then re-run the check.`;
}
