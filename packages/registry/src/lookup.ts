/**
 * Registry lookups: tolerant model-id matching, per-provider views, the tier ladder and short descriptions.
 * Pure functions over the data in models.ts (or a caller-supplied catalog). Id normalisation and matching are the
 * core's (`normaliseModelId` / `modelIdMatches`), so seating and the registry agree on what an id means.
 */
import {
  isCloudTag,
  isLocalProvider,
  type ModelInfo,
  type ModelTierClass,
  modelIdMatches,
  normaliseModelId,
  type ProviderId,
} from "@merge-safely/core";
import { MODELS } from "./models.js";

/**
 * Providers that serve another (first-party) provider's models: Claude on Bedrock/Vertex/compatible gateways,
 * OpenAI on Azure. Partner pricing can differ from first-party list prices; the first-party rate is the estimate.
 * Models reached through an alias never inherit `zeroCost`: a paid gateway serving an open model is not free.
 */
const PROVIDER_FAMILY: Record<string, ProviderId[]> = {
  bedrock: ["anthropic"],
  vertex: ["anthropic", "gemini"],
  "anthropic-compatible": ["anthropic"],
  "azure-openai": ["openai"],
  "openai-compatible": ["openai", "anthropic", "gemini", "ollama"],
};

export function familyOf(provider: ProviderId): ProviderId[] {
  return PROVIDER_FAMILY[provider] ?? [provider];
}

/** A registry entry as seen through `provider`; aliased entries lose `zeroCost` (and so carry no pricing at all). */
function viewAs(m: ModelInfo, provider: ProviderId): ModelInfo {
  if (m.provider === provider) return m;
  const { zeroCost: _drop, ...rest } = m;
  return { ...rest, provider };
}

/** Every model a provider can name (its own, or its family's), in preference order. */
export function modelsFor(provider: ProviderId, catalog: ModelInfo[] = MODELS): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const p of familyOf(provider)) {
    for (const m of catalog) if (m.provider === p) out.push(viewAs(m, provider));
  }
  return out;
}

/** The registry entry (in its first-party form) for an id, searching `provider`'s family. */
function findSource(provider: ProviderId, name: string, catalog: ModelInfo[]): ModelInfo | undefined {
  const id = normaliseModelId(name);
  let best: ModelInfo | undefined;
  for (const p of familyOf(provider)) {
    for (const m of catalog) {
      if (m.provider !== p) continue;
      const n = m.name.toLowerCase();
      if (n === id) return m;
      // `:tag` variants only for a local model asked for under its own local provider.
      const allowTag = isLocalProvider(m.provider) && m.provider === provider;
      if (modelIdMatches(id, n, { allowTag }) && (!best || n.length > best.name.length)) best = m;
    }
  }
  return best;
}

/**
 * Find a model by provider and id. Exact match first, then the longest registry name that the id extends with a
 * date/version suffix (or, for local providers, a `:tag`). Returns undefined for unknown models; callers then use
 * `withPricing` for a pessimistic rate. A local `…-cloud` tag is returned without `zeroCost`.
 */
export function findModel(provider: ProviderId, name: string, catalog: ModelInfo[] = MODELS): ModelInfo | undefined {
  const src = findSource(provider, name, catalog);
  if (!src) return undefined;
  const view = viewAs(src, provider);
  if (view.zeroCost && isCloudTag(name)) {
    const { zeroCost: _drop, ...rest } = view;
    return rest;
  }
  return view;
}

const TIER_ORDER: ModelTierClass[] = ["frontier", "mid", "small"];

export function tierRank(tier: ModelTierClass): number {
  return TIER_ORDER.length - 1 - TIER_ORDER.indexOf(tier);
}

/** The preferred model at each tier for one provider (or family member), strongest first. */
function ladderOf(models: ModelInfo[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const tier of TIER_ORDER) {
    const m = models.find((x) => x.tier === tier);
    if (m) out.push(m);
  }
  return out;
}

/**
 * The preferred model at each tier for a provider, strongest first. For an alias provider (Bedrock, Vertex,
 * compatible gateways) pass `family` to get one first-party family's ladder; otherwise the provider's first family.
 */
export function ladderFor(provider: ProviderId, catalog: ModelInfo[] = MODELS, family?: ProviderId): ModelInfo[] {
  const fam = family ?? familyOf(provider)[0] ?? provider;
  if (!familyOf(provider).includes(fam)) return [];
  return ladderOf(catalog.filter((m) => m.provider === fam).map((m) => viewAs(m, provider)));
}

/**
 * The preferred model one tier below `current`, staying inside `current`'s first-party family (a Claude model on
 * an OpenAI-compatible gateway steps to a cheaper Claude, never to GPT). Skips a missing tier; undefined at the
 * bottom, or when `current` is not a registry model reachable through `provider`.
 */
export function cheaperModel(
  provider: ProviderId,
  current: ModelInfo,
  catalog: ModelInfo[] = MODELS,
): ModelInfo | undefined {
  const src = findSource(provider, current.name, catalog);
  const family = src?.provider ?? (familyOf(provider).includes(current.provider) ? current.provider : undefined);
  if (!family) return undefined;
  const rank = tierRank(current.tier);
  return ladderFor(provider, catalog, family).find((m) => tierRank(m.tier) < rank);
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
