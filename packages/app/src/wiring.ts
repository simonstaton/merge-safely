/**
 * Static wiring shared by every installation: provider adapters, prompt builders and pricing.
 */
import type { ModelInfo, ModelProvider, ModelRef } from "@merge-safely/core";
import { buildHunterPrompt, buildJudgePrompt, requireLens } from "@merge-safely/lenses";
import { allProviders } from "@merge-safely/provider-compatible";
import { createProviderRegistry, type ProviderRegistry } from "@merge-safely/providers";
import { cheaperModel, findModel, normaliseModelId, priceUsage, withPricing } from "@merge-safely/registry";
import type { Pricing, PromptBuilders } from "./gate.js";

/**
 * Every provider adapter this build ships: Anthropic, OpenAI, Gemini, plus the base-URL presets (openai-compatible,
 * anthropic-compatible, and the zero-cost local ollama / lmstudio presets).
 */
export function defaultProviders(): ModelProvider[] {
  return allProviders();
}

export function defaultRegistry(providers: ModelProvider[] = defaultProviders()): ProviderRegistry {
  return createProviderRegistry(providers);
}

export const prompts: PromptBuilders = {
  hunter(lens, input, opts) {
    const p = buildHunterPrompt(requireLens(lens), input, opts ?? {});
    return { system: p.system, user: p.user };
  },
  judge(input, opts) {
    const p = buildJudgePrompt(input, opts ?? {});
    return { system: p.system, user: p.user };
  },
};

const sameModel = (a: string, b: string) => normaliseModelId(a) === normaliseModelId(b);

export const pricing: Pricing = {
  withPricing,
  price: (model, usage) => priceUsage(model, usage),
  cheaper(model: ModelRef, catalog: ModelInfo[]): ModelRef | undefined {
    const current = catalog.find((m) => sameModel(m.name, model.name)) ?? findModel(model.provider, model.name);
    if (!current) return undefined;
    const next = cheaperModel(model.provider, current);
    if (!next) return undefined;
    // Only step to a model this connection can actually reach.
    if (catalog.length > 0 && !catalog.some((m) => sameModel(m.name, next.name))) return undefined;
    return { connectionId: model.connectionId, provider: model.provider, name: next.name };
  },
  normalise: normaliseModelId,
};
