import type { Connection, ModelInfo, ModelTierClass } from "@merge-safely/core";
import { findModel, withPricing } from "@merge-safely/registry";

/**
 * Model metadata comes from @merge-safely/registry (exact or safe date/version-suffix match). A model
 * the registry does not know is priced with the registry's pessimistic fallback via `withPricing`.
 */

/** Conservative limits for models neither the registry nor the provider describes. */
export const UNKNOWN_LIMITS = { contextTokens: 128_000, maxOutputTokens: 8_192 } as const;

/**
 * Snapshots priced differently from the base id they normalise to. They never inherit the base
 * entry's rate: `gpt-4o-2024-05-13` is $5/$15 per MTok, double `gpt-4o`.
 */
const SNAPSHOTS_PRICED_APART = new Set(["gpt-4o-2024-05-13"]);

/** Strip a gateway vendor prefix ("openai/gpt-5") and a dated snapshot suffix ("-2025-08-07"). For tiers and filters only. */
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

export function toModelInfo(id: string, conn: Pick<Connection, "provider">): ModelInfo {
  const pricedApart = SNAPSHOTS_PRICED_APART.has(id.replace(/^.*\//, "").toLowerCase());
  const reg = pricedApart ? undefined : findModel(conn.provider, id);
  if (reg) return { ...reg, provider: conn.provider, name: id };
  return withPricing({
    provider: conn.provider,
    name: id,
    supportsTools: true,
    supportsStructuredOutput: false,
    ...UNKNOWN_LIMITS,
    tier: guessTier(id),
  });
}
