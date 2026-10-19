import { execCommand } from "./exec.js";
import { defaultProviderRegistry, realGateFactory } from "./gate.js";
import { githubApi, quietOctokit } from "./github-api.js";
import { processIO } from "./io.js";
import type { CliContext } from "./runtime.js";

/** The production context: real streams, real git/gh, real providers and the real gate. */
export function defaultContext(): CliContext {
  return {
    io: processIO(),
    env: process.env,
    cwd: process.cwd(),
    exec: execCommand,
    gateFactory: realGateFactory(defaultProviderRegistry),
    registry: defaultProviderRegistry,
    github: (token, logger) => githubApi(quietOctokit(token, logger)),
    octokit: (token, logger) => quietOctokit(token, logger),
    onSignal: (handler) => {
      const on = (sig: NodeJS.Signals) => handler(sig);
      process.once("SIGINT", on);
      process.once("SIGTERM", on);
      return () => {
        process.removeListener("SIGINT", on);
        process.removeListener("SIGTERM", on);
      };
    },
    now: () => new Date(),
  };
}
