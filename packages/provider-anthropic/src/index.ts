// @merge-safely/provider-anthropic — Anthropic Messages API runner and Claude Code CLI runner

export { classifyExit, type ExitClass, type ExitSignals, RECOVERY_TURNS, RECOVERY_USD } from "./classify.js";
export {
  buildCliEnv,
  CLI_DISALLOWED_TOOLS,
  CLI_TOOLS,
  ClaudeCodeRunner,
  type ClaudeCodeRunnerConfig,
  cliAllowedTools,
} from "./cli-runner.js";
export { type AnthropicLike, createAnthropicClient, describeApiError, parseRetryAfter } from "./client.js";
export {
  MAX_OUTPUT_TOKENS_CAP,
  MAX_SCHEMA_RETRIES,
  MessagesRunner,
  type MessagesRunnerConfig,
  SUBMIT_REVIEW_TOOL,
  submitReviewTool,
  toAnthropicToolDefs,
} from "./messages-runner.js";
export { guessTier, KNOWN_MODELS, localModels, lookupKnownModel, priceUsage, toModelInfo } from "./models.js";
export {
  ANTHROPIC_CONNECTION_KINDS,
  type AnthropicProviderOptions,
  anthropicProvider,
  usesCliRunner,
} from "./provider.js";
export { scrub } from "./secrets.js";
export { type CliResult, StreamJsonParser } from "./stream-json.js";
