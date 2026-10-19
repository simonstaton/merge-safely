import type { ModelInfo, ModelPricing, ModelTierClass, TokenUsage } from "@merge-safely/core";

/**
 * Small local model table. The registry package is the source of truth once it lands; this table only
 * fills gaps (runtime ids with no capability fields, subscription connections with no models endpoint).
 * Rates are USD per million tokens, first-party Claude API list prices. Cache write is the 5-minute TTL rate.
 */
interface KnownModel {
  id: string;
  displayName: string;
  contextTokens: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
}

const p = (inPerMTok: number, outPerMTok: number, cachedInPerMTok: number): ModelPricing => ({
  inPerMTok,
  outPerMTok,
  cachedInPerMTok,
  cacheWritePerMTok: inPerMTok * 1.25,
});

const M = 1_000_000;
const K128 = 128_000;

export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(10, 50, 0.25),
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(10, 50, 1),
  },
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(4, 20, 0.2),
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(5, 25, 0.5),
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(5, 25, 0.5),
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(5, 25, 0.5),
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(5, 25, 0.5),
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(2, 10, 0.2),
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(2, 10, 0.2),
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(3, 15, 0.3),
  },
  // Haiku 5.5 is priced higher above 100K prompt tokens; this table carries the base rate.
  {
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    contextTokens: M,
    maxOutputTokens: K128,
    pricing: p(0.1, 0.5, 0.01),
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    pricing: p(1, 5, 0.1),
  },
];

export const DEFAULT_CONTEXT_TOKENS = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** Longest known id that prefixes `id` (handles dated snapshots such as claude-haiku-4-5-20251001). */
export function lookupKnownModel(id: string): KnownModel | undefined {
  let best: KnownModel | undefined;
  for (const m of KNOWN_MODELS) {
    if ((id === m.id || id.startsWith(`${m.id}-`)) && (!best || m.id.length > best.id.length)) best = m;
  }
  return best;
}

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

export function toModelInfo(m: RuntimeModel, source: string): ModelInfo {
  const known = lookupKnownModel(m.id);
  const info: ModelInfo = {
    provider: "anthropic",
    name: m.id,
    displayName: m.display_name ?? known?.displayName,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: m.max_input_tokens ?? known?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: m.max_tokens ?? known?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    tier: guessTier(m.id),
    source,
  };
  if (known) info.pricing = { ...known.pricing };
  return info;
}

/** The local table as ModelInfo; under a subscription connection every model is plan-included. */
export function localModels(opts: { planIncluded: boolean }): ModelInfo[] {
  return KNOWN_MODELS.map((m) => {
    const info = toModelInfo({ id: m.id, display_name: m.displayName }, opts.planIncluded ? "plan-included" : "local");
    if (opts.planIncluded) info.zeroCost = true;
    return info;
  });
}

/**
 * USD for a token usage at a pricing. `in` excludes cached tokens (Anthropic reports them separately).
 * Unknown cache rates fall back to the conventional 0.1x read / 1.25x write multipliers.
 */
export function priceUsage(pricing: ModelPricing | undefined, usage: TokenUsage): number | undefined {
  if (!pricing) return undefined;
  const cachedRate = pricing.cachedInPerMTok ?? pricing.inPerMTok * 0.1;
  const writeRate = pricing.cacheWritePerMTok ?? pricing.inPerMTok * 1.25;
  return (
    (usage.in * pricing.inPerMTok +
      usage.out * pricing.outPerMTok +
      (usage.cachedIn ?? 0) * cachedRate +
      (usage.cacheWrite ?? 0) * writeRate) /
    1_000_000
  );
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
