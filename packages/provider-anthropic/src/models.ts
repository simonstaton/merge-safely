import type { ModelInfo, ModelTierClass, TokenUsage } from "@merge-safely/core";
import { findModel, modelsFor, priceUsage, withPricing } from "@merge-safely/registry";

/** Capability defaults for an id the registry does not know. */
export const DEFAULT_CONTEXT_TOKENS = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export function guessTier(id: string): ModelTierClass {
  const s = id.toLowerCase();
  if (s.includes("opus") || s.includes("fable") || s.includes("mythos")) return "frontier";
  if (s.includes("haiku")) return "small";
  return "mid";
}

export interface RuntimeModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
}

/**
 * A runtime model as ModelInfo: registry data (pricing, effort levels) when the id is known, the API's capability
 * fields when present, else defaults. Unknown ids keep `pricing: undefined`; runners price them pessimistically.
 */
export function toModelInfo(m: RuntimeModel, source: string): ModelInfo {
  const known = findModel("anthropic", m.id);
  const info: ModelInfo = {
    ...(known ?? {}),
    provider: "anthropic",
    name: m.id,
    displayName: m.display_name ?? known?.displayName,
    supportsTools: true,
    supportsStructuredOutput: known?.supportsStructuredOutput ?? true,
    contextTokens: m.max_input_tokens ?? known?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: m.max_tokens ?? known?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    tier: known?.tier ?? guessTier(m.id),
    source,
  };
  return info;
}

/** The registry's Anthropic models; under a subscription connection every model is plan-included. */
export function localModels(opts: { planIncluded: boolean }): ModelInfo[] {
  return modelsFor("anthropic").map((m) => (opts.planIncluded ? { ...m, zeroCost: true, source: "plan-included" } : m));
}

/**
 * USD for a usage delta. Zero-cost models are 0; unknown pricing uses the registry's pessimistic rate
 * (max of every known rate) so maxUsd always enforces, and `estimated` is true.
 */
export function priceFor(model: ModelInfo, usage: TokenUsage): { usd: number; estimated: boolean } {
  if (model.zeroCost) return { usd: 0, estimated: false };
  const estimated = model.pricing === undefined;
  return { usd: priceUsage(withPricing(model), usage).usd, estimated };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cachedIn: (a.cachedIn ?? 0) + (b.cachedIn ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  };
}

export const ZERO_USAGE: TokenUsage = { in: 0, out: 0, cachedIn: 0, cacheWrite: 0 };
