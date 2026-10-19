/**
 * Per-installation settings: budget ceiling overrides and the alert latch (design 7.6 "Survives restarts").
 *
 * Override semantics, per ceiling:
 *   null  never configured: the repository policy (or the built-in default) applies
 *   0     explicitly disabled: the ceiling never blocks, whatever the policy says
 *   n > 0 the limit in USD, replacing the policy value
 * Overrides win over the repository policy because the operator pays the bill and the policy can be edited by repo
 * writers. A stored value the validator rejects falls back to null with a logged error rather than refusing to start.
 */
import { AlertLatch, type Logger, type Policy } from "@merge-safely/core";
import type { AppDb } from "./db.js";

export const BUDGET_KEYS = ["perChangeUsd", "windowUsd", "spendLimitUsd", "perInstallationMonthlyUsd"] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];
export type BudgetOverrides = Record<BudgetKey, number | null>;

export const BUDGET_LABELS: Record<BudgetKey, string> = {
  perChangeUsd: "Per change (one PR, all rounds)",
  windowUsd: "Rolling window (installation)",
  spendLimitUsd: "All-time (installation, this gate's ledger)",
  perInstallationMonthlyUsd: "Monthly (installation, rolling 30 days)",
};

const settingKey = (k: BudgetKey) => `budget.${k}`;
export const LATCH_KEY = "alerts.latch";

export function emptyOverrides(): BudgetOverrides {
  return { perChangeUsd: null, windowUsd: null, spendLimitUsd: null, perInstallationMonthlyUsd: null };
}

/** Validate one stored or submitted value: null, or a finite number >= 0. */
export function validOverride(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
}

export function loadBudgetOverrides(db: AppDb, installationId: number, logger?: Logger): BudgetOverrides {
  const out = emptyOverrides();
  for (const k of BUDGET_KEYS) {
    const s = db.getSetting(installationId, settingKey(k));
    if (!s.found) continue;
    if (validOverride(s.value)) {
      out[k] = s.value;
    } else {
      logger?.error("stored budget override is invalid; using the default (null) instead", {
        installationId,
        key: settingKey(k),
      });
    }
  }
  return out;
}

export function saveBudgetOverrides(db: AppDb, installationId: number, o: BudgetOverrides): void {
  for (const k of BUDGET_KEYS) db.setSetting(installationId, settingKey(k), o[k]);
}

/** Apply installation overrides on top of a parsed policy. null leaves the policy value untouched. */
export function applyBudgetOverrides(policy: Policy, o: BudgetOverrides): Policy {
  const budget = { ...policy.budget };
  for (const k of BUDGET_KEYS) {
    const v = o[k];
    if (v !== null) budget[k] = v;
  }
  return { ...policy, budget };
}

/** Parse one form field: "" = null (never configured), otherwise a non-negative number. */
export function parseOverrideField(raw: string | undefined): { ok: true; value: number | null } | { ok: false } {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false };
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

export function loadLatch(db: AppDb, installationId: number, thresholds: number[]): AlertLatch {
  const s = db.getSetting(installationId, LATCH_KEY);
  return AlertLatch.fromJSON(s.found ? s.value : undefined, thresholds);
}

export function saveLatch(db: AppDb, installationId: number, latch: AlertLatch): void {
  db.setSetting(installationId, LATCH_KEY, latch.toJSON());
}
