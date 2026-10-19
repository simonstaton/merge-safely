/**
 * Pricing math. Unknown models are priced at the maximum of every known rate (the pessimistic fallback) so budgets
 * always enforce and the only possible error is an over-estimate. Zero-cost models price at exactly zero.
 *
 * TokenUsage convention: `in` is input tokens NOT served from cache; `cachedIn` (cache reads) and `cacheWrite` are
 * charged separately at their own rates. An adapter that reports inclusive input will over-charge, never under-charge.
 */
import type { ModelInfo, ModelPricing, TokenUsage } from "@merge-safely/core";
import { MODELS, REGISTRY_VERSION } from "./models.js";

/** Cache writes cost this multiple of input when a model has no explicit cache-write rate. */
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

/** Max of every known rate across the registry (or the given catalog). Zero-cost models are ignored. */
export function pessimisticPricing(catalog: ModelInfo[] = MODELS): ModelPricing {
  const p: Required<ModelPricing> = { inPerMTok: 0, outPerMTok: 0, cachedInPerMTok: 0, cacheWritePerMTok: 0 };
  for (const m of catalog) {
    if (m.zeroCost || !m.pricing) continue;
    p.inPerMTok = Math.max(p.inPerMTok, m.pricing.inPerMTok);
    p.outPerMTok = Math.max(p.outPerMTok, m.pricing.outPerMTok);
    p.cachedInPerMTok = Math.max(p.cachedInPerMTok, m.pricing.cachedInPerMTok ?? m.pricing.inPerMTok);
    p.cacheWritePerMTok = Math.max(
      p.cacheWritePerMTok,
      m.pricing.cacheWritePerMTok ?? m.pricing.inPerMTok * DEFAULT_CACHE_WRITE_MULTIPLIER,
    );
  }
  return p;
}

/**
 * Fill missing pricing with the pessimistic fallback and stamp `source`. Ollama (local) models are treated as zero
 * cost. Models that already carry pricing or `zeroCost` are returned with only `source` defaulted.
 */
export function withPricing(model: ModelInfo): ModelInfo {
  if (model.pricing || model.zeroCost) return { ...model, source: model.source ?? REGISTRY_VERSION };
  if (model.provider === "ollama") return { ...model, zeroCost: true, source: model.source ?? REGISTRY_VERSION };
  return { ...model, pricing: pessimisticPricing(), source: `${REGISTRY_VERSION}:pessimistic` };
}

/**
 * Dollar cost of a usage record. `estimated` is true when the pessimistic fallback was used (no pricing given).
 * Pass a ModelInfo to have `zeroCost` honoured; a bare pricing object is always charged.
 */
export function priceUsage(
  pricingOrModel: ModelPricing | ModelInfo | undefined,
  usage: TokenUsage,
): { usd: number; estimated: boolean } {
  let pricing: ModelPricing | undefined;
  if (pricingOrModel && "tier" in pricingOrModel) {
    if (pricingOrModel.zeroCost) return { usd: 0, estimated: false };
    pricing = pricingOrModel.pricing;
  } else {
    pricing = pricingOrModel;
  }
  const estimated = pricing === undefined;
  const p = pricing ?? pessimisticPricing();
  const cachedRate = p.cachedInPerMTok ?? p.inPerMTok;
  const writeRate = p.cacheWritePerMTok ?? p.inPerMTok * DEFAULT_CACHE_WRITE_MULTIPLIER;
  const usd =
    (nonNeg(usage.in) * p.inPerMTok +
      nonNeg(usage.out) * p.outPerMTok +
      nonNeg(usage.cachedIn) * cachedRate +
      nonNeg(usage.cacheWrite) * writeRate) /
    1_000_000;
  return { usd, estimated };
}

function nonNeg(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}
