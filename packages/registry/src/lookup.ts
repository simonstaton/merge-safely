/**
 * Registry lookups: tolerant model-id matching, per-provider views, the tier ladder and short descriptions.
 * Pure functions over the data in models.ts (or a caller-supplied catalog).
 */
import type { ModelInfo, ModelTierClass, ProviderId } from "@merge-safely/core";
import { MODELS } from "./models.js";

/**
 * Providers that serve another provider's models. Claude on Bedrock/Vertex/compatible gateways, OpenAI on Azure.
 * Partner pricing can differ from first-party list prices; the first-party rate is used as the estimate.
 */
const PROVIDER_FAMILY: Record<string, ProviderId[]> = {
  bedrock: ["anthropic"],
  vertex: ["anthropic", "gemini"],
  "anthropic-compatible": ["anthropic"],
  "azure-openai": ["openai"],
  "openai-compatible": ["openai", "anthropic", "gemini", "ollama"],
};

function familyOf(provider: ProviderId): ProviderId[] {
  return PROVIDER_FAMILY[provider] ?? [provider];
}

/** One date/version token in a suffix: "20260301", "2026", "08", "latest", "preview", "exp", "v1:0", "001". */
const SUFFIX_TOKEN = /^(\d{2,8}|latest|preview|exp|v\d+(:\d+)?)$/;

/** Strip vendor/gateway decorations: "models/gemini-2.5-pro", "us.anthropic.claude-…", "anthropic/claude-…", "[1m]". */
export function normaliseModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]$/, "");
  if (s.startsWith("models/")) s = s.slice("models/".length);
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/^(?:[a-z]{2,6}\.)?(?:anthropic|openai|google)\./, "");
  return s;
}

/**
 * True when `id` is `name` plus a date/version suffix: `-20260301`, `-2026-08-07`, `@20251101`, `-preview-05-20`,
 * `-20250805-v1:0`, or an Ollama `:tag`. A suffix that contains a word ("-mini") is not a date suffix, so
 * `gpt-5` never matches `gpt-5-mini-2025-08-07`.
 */
function isSuffixedVariant(id: string, name: string): boolean {
  if (!id.startsWith(name) || id.length === name.length) return false;
  const sep = id[name.length];
  const rest = id.slice(name.length + 1);
  if (rest.length === 0) return false;
  if (sep === ":") return true;
  if (sep !== "-" && sep !== "@") return false;
  return rest.split("-").every((t) => SUFFIX_TOKEN.test(t));
}

/** Every model a provider (or a provider that serves its family's models) can name, in preference order. */
export function modelsFor(provider: ProviderId, catalog: ModelInfo[] = MODELS): ModelInfo[] {
  const family = familyOf(provider);
  const out: ModelInfo[] = [];
  for (const p of family) {
    for (const m of catalog) if (m.provider === p) out.push(p === provider ? m : { ...m, provider });
  }
  return out;
}

/**
 * Find a model by provider and id. Exact match first, then the longest registry name that the id extends with a
 * date/version suffix. Returns undefined for unknown models (callers then use `withPricing` for a pessimistic rate).
 */
export function findModel(provider: ProviderId, name: string, catalog: ModelInfo[] = MODELS): ModelInfo | undefined {
  const id = normaliseModelId(name);
  const candidates = modelsFor(provider, catalog);
  const exact = candidates.find((m) => m.name.toLowerCase() === id);
  if (exact) return exact;
  let best: ModelInfo | undefined;
  for (const m of candidates) {
    const n = m.name.toLowerCase();
    if (isSuffixedVariant(id, n) && (!best || n.length > best.name.length)) best = m;
  }
  return best;
}

const TIER_ORDER: ModelTierClass[] = ["frontier", "mid", "small"];

export function tierRank(tier: ModelTierClass): number {
  return TIER_ORDER.length - 1 - TIER_ORDER.indexOf(tier);
}

/** The preferred model at each tier for a provider, strongest first. Tiers with no model are omitted. */
export function ladderFor(provider: ProviderId, catalog: ModelInfo[] = MODELS): ModelInfo[] {
  const models = modelsFor(provider, catalog);
  const out: ModelInfo[] = [];
  for (const tier of TIER_ORDER) {
    const m = models.find((x) => x.tier === tier);
    if (m) out.push(m);
  }
  return out;
}

/**
 * The preferred model one tier below `current` within the same provider (frontier → mid → small). If the next tier
 * has no model it skips to the one below. Undefined at small, or when nothing cheaper exists.
 */
export function cheaperModel(
  provider: ProviderId,
  current: ModelInfo,
  catalog: ModelInfo[] = MODELS,
): ModelInfo | undefined {
  const rank = tierRank(current.tier);
  return ladderFor(provider, catalog).find((m) => tierRank(m.tier) < rank);
}

/** Short one-line description for digests, e.g. "Claude Sonnet 5.5 (mid, $2/$10 per MTok)". */
export function describeModel(model: ModelInfo): string {
  const label = model.displayName ?? model.name;
  let price: string;
  if (model.zeroCost) price = "zero cost";
  else if (model.pricing) price = `${usd(model.pricing.inPerMTok)}/${usd(model.pricing.outPerMTok)} per MTok`;
  else price = "pricing unknown";
  return `${label} (${model.tier}, ${price})`;
}

function usd(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(n < 1 ? 3 : 2).replace(/0+$/, "")}`;
}
