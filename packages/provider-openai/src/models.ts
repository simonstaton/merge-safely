import type { Connection, ModelInfo, ModelPricing, ModelTierClass } from "@merge-safely/core";

interface Known {
  contextTokens: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  effortLevels?: string[];
}

const GPT5_EFFORT = ["minimal", "low", "medium", "high"];
const O_EFFORT = ["low", "medium", "high"];

/**
 * Small local table of first-party OpenAI models (USD per million tokens, standard tier).
 * Exact ids only: a prefix match would price e.g. gpt-5-pro at gpt-5 rates and under-enforce budgets.
 * Anything not listed gets `pricing: undefined` so the registry's pessimistic fallback applies.
 */
export const KNOWN_OPENAI_MODELS: Readonly<Record<string, Known>> = {
  "gpt-5": {
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inPerMTok: 1.25, outPerMTok: 10, cachedInPerMTok: 0.125 },
    effortLevels: GPT5_EFFORT,
  },
  "gpt-5-mini": {
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inPerMTok: 0.25, outPerMTok: 2, cachedInPerMTok: 0.025 },
    effortLevels: GPT5_EFFORT,
  },
  "gpt-5-nano": {
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inPerMTok: 0.05, outPerMTok: 0.4, cachedInPerMTok: 0.005 },
    effortLevels: GPT5_EFFORT,
  },
  "gpt-4.1": {
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inPerMTok: 2, outPerMTok: 8, cachedInPerMTok: 0.5 },
  },
  "gpt-4.1-mini": {
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inPerMTok: 0.4, outPerMTok: 1.6, cachedInPerMTok: 0.1 },
  },
  "gpt-4.1-nano": {
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    pricing: { inPerMTok: 0.1, outPerMTok: 0.4, cachedInPerMTok: 0.025 },
  },
  "gpt-4o": {
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inPerMTok: 2.5, outPerMTok: 10, cachedInPerMTok: 1.25 },
  },
  "gpt-4o-mini": {
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inPerMTok: 0.15, outPerMTok: 0.6, cachedInPerMTok: 0.075 },
  },
  o3: {
    contextTokens: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inPerMTok: 2, outPerMTok: 8, cachedInPerMTok: 0.5 },
    effortLevels: O_EFFORT,
  },
  "o4-mini": {
    contextTokens: 200_000,
    maxOutputTokens: 100_000,
    pricing: { inPerMTok: 1.1, outPerMTok: 4.4, cachedInPerMTok: 0.275 },
    effortLevels: O_EFFORT,
  },
};

/** Conservative limits for models we know nothing about. */
export const UNKNOWN_LIMITS = { contextTokens: 128_000, maxOutputTokens: 8_192 } as const;

/** Strip a gateway vendor prefix ("openai/gpt-5") and a dated snapshot suffix ("-2025-08-07"). */
export function baseModelId(id: string): string {
  return id
    .replace(/^.*\//, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .toLowerCase();
}

export function guessTier(id: string): ModelTierClass {
  const m = baseModelId(id);
  if (m.includes("nano")) return "small";
  if (/^(gpt-4o-mini|gpt-4\.1-mini|gpt-3\.5)/.test(m)) return "small";
  if (/^o4-mini-high/.test(m)) return "frontier";
  if (m.includes("mini")) return "mid";
  if (/^(gpt-5|o1|o3|gpt-6)/.test(m)) return "frontier";
  if (/^gpt-4/.test(m)) return "mid";
  return "mid";
}

/** Ids on api.openai.com that are not chat/agentic models (embeddings, audio, images, moderation...). */
const NON_CHAT =
  /(embedding|tts|whisper|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|sora|computer-use)/i;

export function isChatModelId(id: string): boolean {
  const m = baseModelId(id);
  return /^(gpt-|o\d|chatgpt-|codex)/.test(m) && !NON_CHAT.test(m);
}

export function toModelInfo(id: string, conn: Pick<Connection, "provider" | "kind">): ModelInfo {
  const known = KNOWN_OPENAI_MODELS[baseModelId(id)];
  // Pricing from the first-party table only applies to first-party connections; a gateway sets its own prices.
  const firstParty = conn.kind !== "openai-compatible";
  const info: ModelInfo = {
    provider: conn.provider,
    name: id,
    supportsTools: true,
    supportsStructuredOutput: firstParty && known !== undefined,
    contextTokens: known?.contextTokens ?? UNKNOWN_LIMITS.contextTokens,
    maxOutputTokens: known?.maxOutputTokens ?? UNKNOWN_LIMITS.maxOutputTokens,
    tier: guessTier(id),
    source: "runtime",
  };
  if (known && firstParty) info.pricing = { ...known.pricing };
  if (known?.effortLevels) info.effortLevels = [...known.effortLevels];
  return info;
}
