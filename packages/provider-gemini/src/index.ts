// @merge-safely/provider-gemini — Google Gemini runner (generateContent with function calling)

export type { RetryOptions } from "@merge-safely/tools";
export {
  apiKeyOf,
  defaultClientFactory,
  GEMINI_API_VERSION,
  GEMINI_BASE_URL,
  type GeminiModel,
  type GeminiResult,
  type GenAILike,
} from "./client.js";
export { classifyGeminiError, retryDelayFromMessage } from "./errors.js";
export { baseModelId, geminiEffortLevels, guessTier, isAgenticModel, toModelInfo, UNKNOWN_LIMITS } from "./models.js";
export { type GeminiProviderOptions, geminiProvider } from "./provider.js";
export { thinkingConfigFor } from "./transport.js";
