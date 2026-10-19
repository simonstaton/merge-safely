import { gitEnv, resolveBinary, safePathDirs } from "./env.js";
import { type ProcResult, runProcess } from "./proc.js";

/** Everything the tools need about the workspace, resolved once at executor creation. */
export interface ToolContext {
  realRoot: string;
  /** Safe PATH directories (absolute, outside the checkout). */
  pathDirs: string[];
  /** Absolute path of git, or undefined when not installed. */
  gitBin: string | undefined;
  /** Absolute path of ripgrep, or undefined when not installed. */
  rgBin: string | undefined;
}

export function createContext(realRoot: string): ToolContext {
  const pathDirs = safePathDirs(realRoot);
  return {
    realRoot,
    pathDirs,
    gitBin: resolveBinary("git", realRoot, pathDirs),
    rgBin: resolveBinary("rg", realRoot, pathDirs),
  };
}

/**
 * Config pinned on every git invocation so a hostile repository or worktree config cannot run code
 * or reach the network through our own read-only commands.
 */
export function gitHardening(realRoot: string): string[] {
  return [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "core.pager=cat",
    "-c",
    "core.sshCommand=ssh",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "color.ui=never",
    "-c",
    `safe.directory=${realRoot}`,
  ];
}

export function runGit(
  ctx: ToolContext,
  args: string[],
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal | undefined },
): Promise<ProcResult> {
  if (!ctx.gitBin) {
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "",
      combined: "",
      overflow: false,
      timedOut: false,
      aborted: false,
      spawnError: "git is not installed (or only found inside the checkout)",
    });
  }
  return runProcess(ctx.gitBin, [...gitHardening(ctx.realRoot), ...args], {
    cwd: ctx.realRoot,
    env: gitEnv(ctx.pathDirs),
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
