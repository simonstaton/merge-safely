import type { Connection, ModelInfo, ModelTierClass } from "@merge-safely/core";
import { findModel, withPricing } from "@merge-safely/registry";
import type { GeminiModel } from "./client.js";

/**
 * Pricing and limits come from @merge-safely/registry (exact or safe date/version-suffix match); a model
 * it does not know is priced at the registry's pessimistic fallback via `withPricing`. The API's own
 * `inputTokenLimit` / `outputTokenLimit` take precedence for limits. Thinking levels are kept locally
 * because the registry does not record them for Gemini.
 */

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

/**
 * Effort levels each Gemini family accepts. 3.x Pro takes thinkingLevel LOW/HIGH only; 3.x Flash also
 * MINIMAL/MEDIUM; 2.5 maps effort to a thinkingBudget. Unknown families advertise none, so no thinking
 * config is ever sent to them.
 */
export function geminiEffortLevels(name: string): string[] {
  const id = baseModelId(name);
  if (/^gemini-[3-9][\d.]*-pro/.test(id)) return ["low", "high"];
  if (/^gemini-[3-9][\d.]*-flash/.test(id)) return ["minimal", "low", "medium", "high"];
  if (id.startsWith("gemini-2.5-pro")) return ["low", "medium", "high"];
  if (id.startsWith("gemini-2.5-flash")) return ["minimal", "low", "medium", "high"];
  return [];
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
  const reg = findModel(conn.provider, name);
  const base: ModelInfo = reg
    ? { ...reg, provider: conn.provider, name }
    : withPricing({
        provider: conn.provider,
        name,
        supportsTools: true,
        supportsStructuredOutput: true,
        ...UNKNOWN_LIMITS,
        tier: guessTier(name),
      });
  const info: ModelInfo = {
    ...base,
    contextTokens: m.inputTokenLimit ?? base.contextTokens,
    maxOutputTokens: m.outputTokenLimit ?? base.maxOutputTokens,
  };
  if (m.displayName) info.displayName = m.displayName;
  const levels = info.effortLevels ?? geminiEffortLevels(name);
  if (levels.length > 0) info.effortLevels = levels;
  return info;
}
