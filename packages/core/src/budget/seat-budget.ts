/**
 * Per-seat budgets from policy, and panel cost estimation over an injected per-seat estimator.
 * The estimator is injected because core cannot depend on the registry (pricing lives there).
 */
import type { Policy } from "../policy/schema.js";
import type { Seat, SeatBudget, SeatRole } from "../types.js";

/**
 * The hard per-run budget for a seat. `budget.perSeatUsd: 0` means explicitly disabled, so `maxUsd` is omitted;
 * turns and deadline always apply. Hunters and judges share the policy today; `role` is accepted so they can diverge.
 */
export function seatBudgetFromPolicy(policy: Policy, _role: SeatRole): SeatBudget {
  const b = policy.budget;
  const budget: SeatBudget = { maxTurns: b.seatMaxTurns, deadlineMs: b.seatDeadlineMs };
  if (b.perSeatUsd > 0) budget.maxUsd = b.perSeatUsd;
  return budget;
}

/**
 * Sum the estimates of a panel. Seats the estimator cannot price are listed in `unknownSeats` and excluded from
 * `usd`; `usd` is undefined only when no seat could be priced at all.
 */
export function estimatePanel(
  seats: Seat[],
  estimate: (seat: Seat) => number | undefined,
): { usd?: number; unknownSeats: string[] } {
  let usd: number | undefined;
  const unknownSeats: string[] = [];
  for (const s of seats) {
    const e = estimate(s);
    if (e === undefined || !Number.isFinite(e)) unknownSeats.push(s.id);
    else usd = (usd ?? 0) + Math.max(0, e);
  }
  return usd === undefined ? { unknownSeats } : { usd, unknownSeats };
}
