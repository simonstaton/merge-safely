// @merge-safely/provider-gemini — Google Gemini runner (generateContent with function calling)

export { apiKeyOf, defaultClientFactory, type GeminiModel, type GeminiResult, type GenAILike } from "./client.js";
export { priceUsage } from "./common/pricing.js";
export type { RetryOptions } from "./common/retry.js";
export { classifyGeminiError, retryDelayFromMessage } from "./errors.js";
export { baseModelId, guessTier, isAgenticModel, KNOWN_GEMINI_MODELS, toModelInfo } from "./models.js";
export { type GeminiProviderOptions, geminiProvider } from "./provider.js";
export { thinkingConfigFor } from "./transport.js";
