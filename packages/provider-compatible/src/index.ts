// @merge-safely/provider-compatible — OpenAI-compatible and Anthropic-compatible base-URL presets

export { openaiCompatibleProvider } from "@merge-safely/provider-openai";
export { type AllProvidersOptions, allProviders, compatibleProviders } from "./all.js";
export { anthropicCompatibleProvider } from "./anthropic-compatible.js";
export {
  asLocalModel,
  LMSTUDIO_BASE_URL,
  type LocalProviderOptions,
  lmstudioProvider,
  localProvider,
  OLLAMA_BASE_URL,
  ollamaProvider,
  withLocalDefaults,
} from "./local.js";
