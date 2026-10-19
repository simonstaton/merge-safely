import { octokitFromToken } from "@merge-safely/github";
import { execCommand } from "./exec.js";
import { defaultProviderRegistry, realGateFactory } from "./gate.js";
import { githubApi } from "./github-api.js";
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
    github: (token) => githubApi(octokitFromToken(token)),
    now: () => new Date(),
  };
}
