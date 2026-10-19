import type { Connection, ModelInfo, ModelPricing, ModelTierClass } from "@merge-safely/core";
import type { GeminiModel } from "./client.js";

interface Known {
  contextTokens: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  effortLevels: string[];
}

/**
 * Small local table (USD per million tokens). Pro models have a long-context surcharge above 200k
 * prompt tokens; the runner cannot know the prompt size up front, so the higher band is used. That
 * over-estimates typical reviews, which is the safe direction for budget enforcement (design 7.6).
 * Exact ids only; anything else is unpriced and falls back to the registry's pessimistic rate.
 */
export const KNOWN_GEMINI_MODELS: Readonly<Record<string, Known>> = {
  "gemini-2.5-pro": {
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inPerMTok: 2.5, outPerMTok: 15, cachedInPerMTok: 0.625 },
    effortLevels: ["low", "medium", "high"],
  },
  "gemini-2.5-flash": {
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inPerMTok: 0.3, outPerMTok: 2.5, cachedInPerMTok: 0.075 },
    effortLevels: ["minimal", "low", "medium", "high"],
  },
  "gemini-2.5-flash-lite": {
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inPerMTok: 0.1, outPerMTok: 0.4, cachedInPerMTok: 0.025 },
    effortLevels: ["minimal", "low", "medium", "high"],
  },
  "gemini-2.0-flash": {
    contextTokens: 1_048_576,
    maxOutputTokens: 8_192,
    pricing: { inPerMTok: 0.1, outPerMTok: 0.4, cachedInPerMTok: 0.025 },
    effortLevels: [],
  },
  "gemini-3-pro-preview": {
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inPerMTok: 4, outPerMTok: 18, cachedInPerMTok: 0.4 },
    effortLevels: ["low", "high"],
  },
};

export const UNKNOWN_LIMITS = { contextTokens: 128_000, maxOutputTokens: 8_192 } as const;

/** "models/gemini-2.0-flash-001" -> "gemini-2.0-flash". */
export function baseModelId(name: string): string {
  return name
    .replace(/^models\//, "")
    .replace(/-\d{3}$/, "")
    .toLowerCase();
}

export function guessTier(name: string): ModelTierClass {
  const m = baseModelId(name);
  if (m.includes("flash-lite") || m.includes("gemma") || m.includes("nano")) return "small";
  if (m.includes("flash")) return "mid";
  if (m.includes("pro") || m.includes("ultra")) return "frontier";
  return "mid";
}

const NON_AGENTIC = /(embedding|tts|image|live|audio|veo|imagen|aqa|robotics|computer-use)/i;

/** Keep text models that support generateContent (and therefore function calling). */
export function isAgenticModel(m: GeminiModel): boolean {
  const id = baseModelId(m.name ?? "");
  if (!id.startsWith("gemini-") || NON_AGENTIC.test(id)) return false;
  return !m.supportedActions || m.supportedActions.includes("generateContent");
}

export function toModelInfo(m: GeminiModel, conn: Pick<Connection, "provider">): ModelInfo {
  const name = (m.name ?? "").replace(/^models\//, "");
  const known = KNOWN_GEMINI_MODELS[baseModelId(name)];
  const info: ModelInfo = {
    provider: conn.provider,
    name,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: m.inputTokenLimit ?? known?.contextTokens ?? UNKNOWN_LIMITS.contextTokens,
    maxOutputTokens: m.outputTokenLimit ?? known?.maxOutputTokens ?? UNKNOWN_LIMITS.maxOutputTokens,
    tier: guessTier(name),
    source: "runtime",
  };
  if (m.displayName) info.displayName = m.displayName;
  if (known) info.pricing = { ...known.pricing };
  if (known && known.effortLevels.length > 0) info.effortLevels = [...known.effortLevels];
  return info;
}
