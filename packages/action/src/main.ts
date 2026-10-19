/**
 * Entry point of the bundled Action (dist/index.js). Wires the real @actions/core, Octokit and gate factory into
 * `run`, which never throws, and sets the process exit code the CLI would use.
 */
import { readFile } from "node:fs/promises";
import * as core from "@actions/core";
import { defaultProviderRegistry, githubApi, realGateFactory } from "@merge-safely/cli";
import { octokitFromToken } from "@merge-safely/github";
import { type ActionCore, type RunDeps, run } from "./run.js";

const actionCore: ActionCore = {
  getInput: (name) => core.getInput(name),
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (message) => core.setFailed(message),
  setSecret: (secret) => core.setSecret(secret),
  debug: (msg) => core.debug(msg),
  info: (msg) => core.info(msg),
  notice: (msg) => core.notice(msg),
  warning: (msg) => core.warning(msg),
  error: (msg) => core.error(msg),
  async writeSummary(markdown) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    try {
      await core.summary.addRaw(markdown, true).write();
    } catch (_err: unknown) {
      core.debug("could not write the job summary");
    }
  },
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (_err: unknown) {
    return null;
  }
}

function apiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.GITHUB_API_URL;
  return url && url !== "https://api.github.com" ? url : undefined;
}

/** One Octokit construction for the Action and the gate, honouring GITHUB_API_URL (GitHub Enterprise Server). */
function octokitFor(token: string) {
  const baseUrl = apiBaseUrl(process.env);
  const o = octokitFromToken(token, { userAgent: "merge-safely-action", ...(baseUrl ? { baseUrl } : {}) });
  // Octokit prints every non-2xx (an expected 404 for a missing policy, 403 on GET /app) to the console; the
  // adapters handle those, so keep them in the debug log only.
  const quiet = (msg: string) => core.debug(String(msg));
  o.log = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  return o;
}

const deps: RunDeps = {
  core: actionCore,
  env: process.env,
  readFile: readText,
  github(token) {
    const octokit = octokitFor(token);
    const api = githubApi(octokit);
    return { octokit, getFile: (repo, path, ref) => api.getFile(repo, path, ref) };
  },
  gateFactory: realGateFactory(defaultProviderRegistry, { octokit: octokitFor }),
  onCancel(fn) {
    let done = false;
    const handler = (signal: NodeJS.Signals) => {
      if (done) return;
      done = true;
      core.warning(`Merge Safely: ${signal} received, closing out the review`);
      fn().finally(() => process.exit(130));
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  },
};

run(deps).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() catches everything; this is a last resort that still avoids printing a stack.
    core.setFailed(`error [ERROR]: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
