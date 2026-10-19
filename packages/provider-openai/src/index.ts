// @merge-safely/provider-openai — OpenAI Responses API and Chat Completions runners (incl. OpenAI-compatible endpoints)

export type { RetryOptions } from "@merge-safely/tools";
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
export { classifyOpenAIError, isRetryableStatus } from "./errors.js";
export { baseModelId, guessTier, isChatModelId, toModelInfo, UNKNOWN_LIMITS } from "./models.js";
export {
  type OpenAIProviderOptions,
  type OpenAIWireApi,
  openaiCompatibleProvider,
  openaiProvider,
  strictAllowed,
  wireApiFor,
} from "./provider.js";
