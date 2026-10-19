import type { ModelProvider } from "@merge-safely/core";
import { type AnthropicProviderOptions, anthropicProvider } from "@merge-safely/provider-anthropic";
import { type GeminiProviderOptions, geminiProvider } from "@merge-safely/provider-gemini";
import { type OpenAIProviderOptions, openaiCompatibleProvider, openaiProvider } from "@merge-safely/provider-openai";
import { anthropicCompatibleProvider } from "./anthropic-compatible.js";
import { lmstudioProvider, ollamaProvider } from "./local.js";

export interface AllProvidersOptions {
  /** Passed to `anthropicProvider` and `anthropicCompatibleProvider`. */
  anthropic?: AnthropicProviderOptions;
  /** Passed to `openaiProvider`, `openaiCompatibleProvider` and the local presets. */
  openai?: OpenAIProviderOptions;
  gemini?: GeminiProviderOptions;
}

/** The base-URL presets: openai-compatible, anthropic-compatible, ollama and lmstudio. */
export function compatibleProviders(opts: AllProvidersOptions = {}): ModelProvider[] {
  return [
    openaiCompatibleProvider(opts.openai),
    anthropicCompatibleProvider(opts.anthropic),
    ollamaProvider(opts.openai),
    lmstudioProvider(opts.openai),
  ];
}

/** Every shipped API provider, for `createProviderRegistry(allProviders())` in the CLI, Action and App. */
export function allProviders(opts: AllProvidersOptions = {}): ModelProvider[] {
  return [
    anthropicProvider(opts.anthropic),
    openaiProvider(opts.openai),
    geminiProvider(opts.gemini),
    ...compatibleProviders(opts),
  ];
}
