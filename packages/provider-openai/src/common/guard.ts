import type { Logger, ModelInfo, SeatBudget, TokenUsage } from "@merge-safely/core";
import { addUsage, priceUsage } from "./pricing.js";

export type StopReason = "timeout" | "aborted";

/**
 * Per-seat hard limits: turns, wall-clock deadline, dollars and the caller's abort signal.
 * `signal` fires on deadline or external abort and must be passed to every model and tool call.
 */
export class RunGuard {
  readonly signal: AbortSignal;
  turns = 0;
  tokens: TokenUsage = { in: 0, out: 0 };
  usd: number | undefined;
  private readonly controller = new AbortController();
  private stop: StopReason | undefined;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onExternalAbort: () => void;
  readonly priced: boolean;

  constructor(
    readonly budget: SeatBudget,
    private readonly model: Pick<ModelInfo, "pricing" | "zeroCost" | "name">,
    private readonly external?: AbortSignal,
    logger?: Logger,
  ) {
    this.signal = this.controller.signal;
    this.priced = model.zeroCost === true || model.pricing !== undefined;
    this.usd = this.priced ? 0 : undefined;
    if (!this.priced && budget.maxUsd !== undefined) {
      logger?.warn("model has no known pricing; maxUsd cannot be enforced for this seat", { model: model.name });
    }
    this.onExternalAbort = () => this.abort("aborted");
    if (external?.aborted) this.abort("aborted");
    else external?.addEventListener("abort", this.onExternalAbort, { once: true });
    if (Number.isFinite(budget.deadlineMs) && budget.deadlineMs > 0) {
      this.timer = setTimeout(() => this.abort("timeout"), budget.deadlineMs);
    }
  }

  private abort(reason: StopReason): void {
    if (this.stop) return;
    this.stop = reason;
    this.controller.abort(reason);
  }

  get stopReason(): StopReason | undefined {
    return this.stop;
  }

  /** Record a usage delta and return its price (undefined when the model is unpriced). */
  addUsage(delta: TokenUsage): number | undefined {
    this.tokens = addUsage(this.tokens, delta);
    const usd = priceUsage(delta, this.model);
    if (usd !== undefined && this.usd !== undefined) this.usd += usd;
    return usd;
  }

  overBudget(): boolean {
    return this.budget.maxUsd !== undefined && this.usd !== undefined && this.usd > this.budget.maxUsd;
  }

  turnsExhausted(): boolean {
    return this.turns >= this.budget.maxTurns;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.external?.removeEventListener("abort", this.onExternalAbort);
  }
}
