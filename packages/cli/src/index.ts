// @merge-safely/cli — merge-safely command line (programmatic entry points)
export { buildProgram, runCli } from "./cli.js";
export { CONNECT_PROVIDERS, DEFAULT_KEY_ENV } from "./commands/connect.js";
export { exitFor } from "./commands/review.js";
export * from "./connections-file.js";
export { defaultContext } from "./context.js";
export { autoModels, seatTokens, type TierCost, TYPICAL_PR_LINES, tierCosts } from "./cost.js";
export { CliError, EXIT, errorCode, formatError, SecretSet } from "./errors.js";
export { type Exec, type ExecOptions, type ExecResult, execCommand } from "./exec.js";
export {
  adaptGate,
  buildGateDeps,
  defaultProviderRegistry,
  memoryReporter,
  realGateFactory,
  registryPricing,
  toCliEstimate,
  toCliResult,
} from "./gate.js";
export type * from "./gate-types.js";
export { type GithubApi, githubApi } from "./github-api.js";
export { type HomePaths, homePaths, resolveHome } from "./home.js";
export { type CliIO, processIO } from "./io.js";
export {
  buildLocalChange,
  defaultBaseRef,
  type LocalChange,
  parseNameStatus,
  parseNumstat,
  repoFromRemote,
  splitPatches,
} from "./local-source.js";
export { lintPolicy, POLICY_FILE, POLICY_TEMPLATE, policyFromText } from "./policy.js";
export type { Prompter } from "./prompt.js";
export { type CliContext, Runtime } from "./runtime.js";
export { discoverGithubToken, tokenIdentity } from "./token.js";
export { CLI_VERSION } from "./version.js";
