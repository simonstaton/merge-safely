/**
 * Budget ceilings and admission (design 4.2 step 5, 7.6).
 *
 * Five ceilings are evaluated against a proposed panel before anything runs:
 *   per-seat   budget.perSeatUsd                  one reviewer run
 *   per-change budget.perChangeUsd                one PR across all rounds (spent so far + panel estimate)
 *   window     budget.windowUsd                   installation, rolling window of budget.windowDays
 *   all-time   budget.spendLimitUsd               installation, against the gate's own ledger
 *   monthly    budget.perInstallationMonthlyUsd   installation, calendar month
 *
 * Limit semantics: `null`/`undefined` = never configured (unset), `0` = explicitly disabled. Neither ever breaches.
 * A ceiling breaches when projected spend strictly exceeds the limit, so a zero-cost panel never trips a ceiling
 * that spend already sits on.
 *
 * Fail closed: when a ceiling is configured but its spend input is undefined (no ledger, or a swallowed ledger
 * error), the result is marked `unknownSpend` and counts as breached.
 *
 * Advisory ceilings (`advisory`) are evaluated and reported, but never block admission. The GitHub Action passes
 * `advisory: ["monthly"]` because it cannot see installation-wide monthly spend reliably; the App passes none.
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
  /** The ceiling is configured but its spend input was not supplied; treated as breached (fail closed). */
  unknownSpend?: true;
  /** The caller marked this ceiling advisory: reported, never blocking. */
  advisory?: true;
}

export interface CeilingInput {
  policy: Policy;
  seatEstimates: { seatId: string; usd?: number }[];
  /** Spent so far on this change across all rounds (CostLedger.forChange). */
  changeSpendUsd: number;
  windowSpendUsd?: number;
  allTimeSpendUsd?: number;
  monthlySpendUsd?: number;
  /** Ceilings that warn but never block (the Action passes ["monthly"]). */
  advisory?: CeilingKind[];
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

function money(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

function result(
  ceiling: CeilingKind,
  rawLimit: number | null | undefined,
  spend: number | undefined,
  addUsd: number,
  advisory: ReadonlySet<CeilingKind>,
  seatId?: string,
): CeilingResult {
  const limitUsd = effectiveCeilingLimit(rawLimit);
  const unknown = limitUsd !== null && (spend === undefined || !Number.isFinite(spend));
  const currentUsd = money(spend);
  const projectedUsd = currentUsd + addUsd;
  const r: CeilingResult = {
    ceiling,
    limitUsd,
    currentUsd,
    projectedUsd,
    breached: limitUsd !== null && (unknown || projectedUsd > limitUsd + EPSILON),
    fraction: limitUsd === null ? 0 : projectedUsd / limitUsd,
  };
  if (seatId !== undefined) r.seatId = seatId;
  if (unknown) r.unknownSpend = true;
  if (advisory.has(ceiling)) r.advisory = true;
  return r;
}

export function evaluateCeilings(input: CeilingInput): CeilingResult[] {
  const b = input.policy.budget;
  const adv = new Set(input.advisory ?? []);
  const panelUsd = input.seatEstimates.reduce((s, e) => s + money(e.usd), 0);
  const out: CeilingResult[] = input.seatEstimates.map((e) =>
    result("per-seat", b.perSeatUsd, 0, money(e.usd), adv, e.seatId),
  );
  out.push(result("per-change", b.perChangeUsd, input.changeSpendUsd, panelUsd, adv));
  out.push(result("window", b.windowUsd, input.windowSpendUsd, panelUsd, adv));
  out.push(result("all-time", b.spendLimitUsd, input.allTimeSpendUsd, panelUsd, adv));
  out.push(result("monthly", b.perInstallationMonthlyUsd, input.monthlySpendUsd, panelUsd, adv));
  return out;
}

export type AdmitResult =
  | { ok: true; results: CeilingResult[]; advisoryBreaches: CeilingResult[] }
  | { ok: false; binding: CeilingResult; results: CeilingResult[]; advisoryBreaches: CeilingResult[]; message: string };

/** Precedence for the binding ceiling: installation-wide first (they refuse outright), then per-change, per-seat. */
const PRECEDENCE: CeilingKind[] = ["all-time", "window", "monthly", "per-change", "per-seat"];

/** The binding ceiling among blocking breaches: highest precedence, then unknown spend, then highest fraction. */
export function bindingCeiling(results: CeilingResult[]): CeilingResult | undefined {
  const blocking = results.filter((r) => r.breached && !r.advisory);
  blocking.sort(
    (a, b) =>
      PRECEDENCE.indexOf(a.ceiling) - PRECEDENCE.indexOf(b.ceiling) ||
      Number(b.unknownSpend === true) - Number(a.unknownSpend === true) ||
      b.fraction - a.fraction,
  );
  return blocking[0];
}

/** Admission over already-evaluated results (used by `admit` and by the downgrade ladder). */
export function admitResults(results: CeilingResult[], policy?: Policy): AdmitResult {
  const advisoryBreaches = results.filter((r) => r.breached && r.advisory);
  const binding = bindingCeiling(results);
  if (!binding) return { ok: true, results, advisoryBreaches };
  return { ok: false, binding, results, advisoryBreaches, message: ceilingMessage(binding, policy) };
}

/**
 * Admission check. When any non-advisory ceiling breaches (or its spend is unknown), the binding one is returned
 * with a message naming it and the policy key to raise.
 */
export function admit(input: CeilingInput): AdmitResult {
  return admitResults(evaluateCeilings(input), input.policy);
}

export function ceilingMessage(r: CeilingResult, policy?: Policy): string {
  const key = CEILING_POLICY_KEYS[r.ceiling];
  if (r.unknownSpend) {
    return `Budget ceiling "${r.ceiling}" (${key} = ${usd(r.limitUsd ?? 0)}) cannot be checked: spend for ${r.ceiling} unknown; ledger required. Configure a cost ledger, or unset ${key}, then re-run the check.`;
  }
  const limit = usd(r.limitUsd ?? 0);
  const what =
    r.ceiling === "per-seat"
      ? `seat ${r.seatId ?? "?"} is estimated at ${usd(r.projectedUsd)}`
      : `projected spend ${usd(r.projectedUsd)} (${usd(r.currentUsd)} already spent + ${usd(r.projectedUsd - r.currentUsd)} for this panel)`;
  const scope = r.ceiling === "window" && policy ? ` over the last ${policy.budget.windowDays} day(s)` : "";
  const reset = isInstallationCeiling(r.ceiling) ? ", or reset the gate's spend ledger" : "";
  return `Budget ceiling "${r.ceiling}" would be exceeded: ${what}${scope} against a limit of ${limit}. Raise ${key} in .merge-safely.yml${reset}, then re-run the check.`;
}
