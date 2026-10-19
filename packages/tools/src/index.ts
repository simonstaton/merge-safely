// @merge-safely/tools — Shared read-only tool set and runner-observed audit used by every API runner

export {
  type AnthropicToolShape,
  type ConvertibleTool,
  type GeminiFunctionDeclarationShape,
  type OpenAIFunctionToolShape,
  type OpenAIResponsesToolShape,
  toAnthropicTools,
  toGeminiFunctionDeclarations,
  toOpenAIFunctionTools,
  toOpenAIResponsesTools,
} from "./convert.js";
export { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, READ_ONLY_DEFINITIONS, TOOL_NAMES, type ToolName } from "./definitions.js";
export {
  COMMAND_ENV_PASSTHROUGH,
  commandEnv,
  GIT_ENV_PASSTHROUGH,
  gitEnv,
  resolveBinary,
  safePathDirs,
} from "./env.js";
export {
  createReadOnlyTools,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  type ReadOnlyToolsOptions,
} from "./executor.js";
export { globToRegExp, matchGlob } from "./glob.js";
export { PathError, resolveSafe, type SafePath } from "./paths.js";
export { toolsSystemPromptFragment } from "./prompt.js";
export { REDACTED, redactDiagnostics, redactToolOutput, replaceLiterals } from "./redact.js";
export * from "./runner/index.js";
export { isHiddenPath, isSensitivePath } from "./sensitive.js";
export { SUBMIT_REVIEW_TOOL_NAME, submitReviewDefinition } from "./submit-review.js";
export { type AllowEntry, matchAllowlist, parseAllowEntry, type TokenizeResult, tokenizeCommand } from "./tokenize.js";
export { TRUNCATED_MARKER, truncateOutput } from "./truncate.js";
