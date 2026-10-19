import type { Logger, ModelInfo, SeatBudget, TokenUsage } from "@merge-safely/core";
import { priceUsage } from "@merge-safely/registry";
import { addUsage } from "./usage.js";

export type StopReason = "timeout" | "aborted";

/**
 * Per-seat hard limits: turns, wall-clock deadline, dollars and the caller's abort signal.
 * `signal` fires on deadline or external abort and must be passed to every model and tool call.
 * Spend is priced with the registry: a model without pricing is charged the pessimistic fallback
 * rate, so `maxUsd` always enforces (it can only over-estimate).
 */
export class RunGuard {
  readonly signal: AbortSignal;
  /** Epoch ms at which the seat deadline fires (Infinity when no deadline). */
  readonly deadlineAt: number;
  turns = 0;
  tokens: TokenUsage = { in: 0, out: 0 };
  usd = 0;
  /** True when spend comes from the registry's pessimistic fallback rather than the model's own pricing. */
  readonly estimated: boolean;
  private readonly controller = new AbortController();
  private stop: StopReason | undefined;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onExternalAbort: () => void;

  constructor(
    readonly budget: SeatBudget,
    private readonly model: ModelInfo,
    private readonly external?: AbortSignal,
    logger?: Logger,
  ) {
    this.signal = this.controller.signal;
    this.estimated = model.zeroCost !== true && model.pricing === undefined;
    if (this.estimated) {
      logger?.warn("model has no known pricing; spend and maxUsd use the registry's pessimistic fallback rate", {
        model: model.name,
      });
    }
    this.onExternalAbort = () => this.abort("aborted");
    if (external?.aborted) this.abort("aborted");
    else external?.addEventListener("abort", this.onExternalAbort, { once: true });
    const hasDeadline = Number.isFinite(budget.deadlineMs) && budget.deadlineMs > 0;
    this.deadlineAt = hasDeadline ? Date.now() + budget.deadlineMs : Number.POSITIVE_INFINITY;
    if (hasDeadline) this.timer = setTimeout(() => this.abort("timeout"), budget.deadlineMs);
  }

  private abort(reason: StopReason): void {
    if (this.stop) return;
    this.stop = reason;
    this.controller.abort(reason);
  }

  get stopReason(): StopReason | undefined {
    return this.stop;
  }

  /** Record a usage delta and return its price. */
  addUsage(delta: TokenUsage): number {
    this.tokens = addUsage(this.tokens, delta);
    const { usd } = priceUsage(this.model, delta);
    this.usd += usd;
    return usd;
  }

  overBudget(): boolean {
    return this.budget.maxUsd !== undefined && this.usd > this.budget.maxUsd;
  }

  turnsExhausted(): boolean {
    return this.turns >= this.budget.maxTurns;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.external?.removeEventListener("abort", this.onExternalAbort);
  }
}
