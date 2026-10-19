// @merge-safely/provider-openai — OpenAI Responses API and Chat Completions runners (incl. OpenAI-compatible endpoints)

export {
  type ChatResult,
  type ClientConfig,
  clientConfig,
  defaultClientFactory,
  KEYLESS_PLACEHOLDER,
  OPENAI_BASE_URL,
  type OpenAILike,
  type RequestOpts,
  type ResponsesResult,
} from "./client.js";
export { priceUsage } from "./common/pricing.js";
export type { RetryOptions } from "./common/retry.js";
export { classifyOpenAIError } from "./errors.js";
export { baseModelId, guessTier, isChatModelId, KNOWN_OPENAI_MODELS, toModelInfo } from "./models.js";
export { type OpenAIProviderOptions, type OpenAIWireApi, openaiProvider, wireApiFor } from "./provider.js";
