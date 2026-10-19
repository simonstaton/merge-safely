/**
 * Installation-wide ceilings outside a review (design 7.6: admission AND tick). The gate checks every ceiling when a
 * review is seated; this re-evaluates the installation ceilings (window, all-time, monthly) against the ledger on a
 * timer, at webhook intake and after each job, and fires edge-triggered AlertLatch alerts to the log and Slack.
 *
 * The installation view uses the default policy plus the setup-page overrides; per-repo policy ceilings are enforced
 * by the gate at admission.
 */
import {
  type AlertEvent,
  type CeilingResult,
  type CostLedger,
  DEFAULT_POLICY,
  evaluateCeilings,
  isInstallationCeiling,
} from "@merge-safely/core";
import { type FetchLike, postToWebhook } from "@merge-safely/escalation-slack";
import type { AppDb } from "./db.js";
import { type AppLogger, errText } from "./logger.js";
import { applyBudgetOverrides, loadBudgetOverrides, loadLatch, saveLatch } from "./settings.js";

export interface InstallationSpend {
  windowUsd: number;
  allTimeUsd: number;
  monthlyUsd: number;
  windowDays: number;
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function installationSpend(
  ledger: CostLedger,
  installationId: number,
  now: Date,
  windowDays: number,
): Promise<InstallationSpend> {
  const id = String(installationId);
  const windowMs = Math.max(windowDays, 0) * 24 * 60 * 60 * 1000;
  const [w, a, m] = await Promise.all([
    ledger.forWindow(id, windowMs),
    ledger.allTime(id),
    ledger.forWindow(id, Math.max(now.getTime() - startOfUtcMonth(now).getTime(), 1)),
  ]);
  return { windowUsd: w.usd, allTimeUsd: a.usd, monthlyUsd: m.usd, windowDays };
}

export interface AlertDeps {
  db: AppDb;
  ledger: CostLedger;
  logger: AppLogger;
  slackWebhookUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export function alertText(installationId: number, e: AlertEvent, r: CeilingResult | undefined): string {
  const pct = Math.round(e.fraction * 100);
  const spend = r ? ` ($${r.currentUsd.toFixed(2)} of $${(r.limitUsd ?? 0).toFixed(2)})` : "";
  const what = e.threshold >= 1 ? "reached" : `crossed ${Math.round(e.threshold * 100)}% of`;
  return `Merge Safely budget: installation ${installationId} ${what} its ${e.ceiling} ceiling, now at ${pct}%${spend}.${
    e.threshold >= 1 ? " New reviews are refused at admission until the ceiling is raised or the ledger is reset." : ""
  }`;
}

/** Evaluate one installation's ceilings and fire the alerts that cross a threshold. Never throws. */
export async function evaluateInstallation(deps: AlertDeps, installationId: number): Promise<AlertEvent[]> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const policy = applyBudgetOverrides(DEFAULT_POLICY, loadBudgetOverrides(deps.db, installationId, deps.logger));
    const spend = await installationSpend(deps.ledger, installationId, now, policy.budget.windowDays);
    const results = evaluateCeilings({
      policy,
      seatEstimates: [],
      changeSpendUsd: 0,
      windowSpendUsd: spend.windowUsd,
      allTimeSpendUsd: spend.allTimeUsd,
      monthlySpendUsd: spend.monthlyUsd,
    }).filter((r) => isInstallationCeiling(r.ceiling));
    const latch = loadLatch(deps.db, installationId, policy.budget.alertThresholds);
    const events = latch.observeResults(results);
    saveLatch(deps.db, installationId, latch);
    for (const e of events) {
      const text = alertText(
        installationId,
        e,
        results.find((r) => r.ceiling === e.ceiling),
      );
      deps.logger.warn("budget alert", {
        installationId,
        ceiling: e.ceiling,
        threshold: e.threshold,
        fraction: e.fraction,
      });
      if (deps.slackWebhookUrl) {
        try {
          await postToWebhook(deps.slackWebhookUrl, { text }, deps.fetch ? { fetch: deps.fetch } : {});
        } catch (err: unknown) {
          deps.logger.warn("could not post budget alert to Slack", { installationId, error: errText(err) });
        }
      }
    }
    return events;
  } catch (err: unknown) {
    deps.logger.error("budget evaluation failed", { installationId, error: errText(err) });
    return [];
  }
}
