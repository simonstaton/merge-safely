// @merge-safely/provider-anthropic — Anthropic Messages API runner and Claude Code CLI runner

export { classifyExit, type ExitClass, type ExitSignals, RECOVERY_TURNS, RECOVERY_USD } from "./classify.js";
export {
  buildCliEnv,
  CLI_DISALLOWED_TOOLS,
  CLI_TOOLS,
  ClaudeCodeRunner,
  type ClaudeCodeRunnerConfig,
  cliAllowedTools,
  GIT_WRAPPER_COMMAND,
  writeGitLauncher,
} from "./cli-runner.js";
export { type AnthropicLike, createAnthropicClient, describeApiError, parseRetryAfter } from "./client.js";
export { GIT_SUBCOMMANDS, GitGuardError, planGit, runGitWrapper } from "./git-guard.js";
export {
  MAX_OUTPUT_TOKENS_CAP,
  MAX_SCHEMA_RETRIES,
  MessagesRunner,
  type MessagesRunnerConfig,
  NUDGE_TEXT,
  SUBMIT_REVIEW_TOOL,
  submitReviewTool,
  toAnthropicToolDefs,
} from "./messages-runner.js";
export { guessTier, localModels, priceFor, toModelInfo } from "./models.js";
export {
  ANTHROPIC_CONNECTION_KINDS,
  type AnthropicProviderOptions,
  anthropicProvider,
  usesCliRunner,
} from "./provider.js";
export { envSecretValues, REDACTED, scrub, scrubDeep } from "./secrets.js";
export { type CliResult, StreamJsonParser } from "./stream-json.js";
