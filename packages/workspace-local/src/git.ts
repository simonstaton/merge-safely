import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when git could not be started or was killed. */
  code: number;
}

export interface GitOptions {
  cwd: string;
  /** Extra environment (e.g. GIT_LFS_SKIP_SMUDGE). Applied over the scrubbed base env. */
  env?: Record<string, string>;
  /** Extra config entries, passed via GIT_CONFIG_COUNT (never argv, never disk). Later entries win. */
  config?: ReadonlyArray<readonly [string, string]>;
  /**
   * Keep the user's HOME/XDG_CONFIG_HOME (global config, credential helpers) instead of an empty
   * private HOME, and do not reset credential.helper. Only for fetches that need the user's credentials.
   */
  inheritHome?: boolean;
  /** Kill git after this long. Default 10 minutes (fetches can be slow). */
  timeoutMs?: number;
}

/** Variables passed through from the parent. Everything else, including every GIT_* variable, is dropped. */
export const GIT_ENV_PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "TZ", "SSH_AUTH_SOCK", "SSH_AGENT_PID"] as const;

let privateDirs: { home: string; hooks: string } | undefined;
/** Process-wide private empty dirs: a HOME with no config, and a hooks dir with no hooks. */
export function privateGitDirs(): { home: string; hooks: string } {
  if (!privateDirs) {
    const root = mkdtempSync(join(tmpdir(), "merge-safely-git-"));
    const home = mkdtempSync(join(root, "home-"));
    const hooks = mkdtempSync(join(root, "no-hooks-"));
    privateDirs = { home, hooks };
  }
  return privateDirs;
}

/**
 * Config pinned on every invocation so a poisoned repository, mirror or worktree config cannot run
 * code (hooks, fsmonitor, pager, external diff, ssh command, credential helpers) or reach the network
 * through our own commands. Network-using commands re-enable specific protocols via `config`.
 */
export function gitHardeningConfig(opts: { inheritHome?: boolean } = {}): Array<[string, string]> {
  const cfg: Array<[string, string]> = [
    ["core.hooksPath", privateGitDirs().hooks],
    ["core.fsmonitor", "false"],
    ["diff.external", ""],
    ["core.pager", "cat"],
    ["core.sshCommand", "ssh"],
    ["core.askPass", ""],
    ["protocol.allow", "never"],
    ["submodule.recurse", "false"],
    ["filter.lfs.required", "false"],
  ];
  if (!opts.inheritHome) cfg.push(["credential.helper", ""]);
  return cfg;
}

/** git resolved from absolute PATH entries only, so a relative entry can never pick up a planted binary. */
export function gitBin(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, "git");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return "git-not-found-on-absolute-path";
}

function baseEnv(inheritHome: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of GIT_ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (inheritHome) {
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  } else {
    env.HOME = privateGitDirs().home;
  }
  env.PATH = (env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d && isAbsolute(d))
    .join(delimiter);
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Run git with an args array and no shell, from a scrubbed environment with hardening config.
 * Never rejects; inspect `code`.
 */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  const inheritHome = opts.inheritHome === true;
  const config = [
    ...gitHardeningConfig({ inheritHome }),
    ["safe.directory", opts.cwd] as const,
    ...(opts.config ?? []),
  ];
  const env: NodeJS.ProcessEnv = { ...baseEnv(inheritHome), ...opts.env, GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (code: number, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        code,
      });
    };
    const child = spawn(gitBin(), args, {
      cwd: opts.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(-1, `\ngit timed out after ${opts.timeoutMs ?? 600_000}ms`);
    }, opts.timeoutMs ?? 600_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e: Error) => done(-1, e.message));
    child.on("close", (code: number | null) => done(code ?? -1));
  });
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * Replace every occurrence of each secret (and its base64 forms, which is how tokens travel in
 * http.extraheader) with `***`, and strip userinfo from URLs.
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text.replace(URL_CREDENTIALS, "$1***@");
  const variants = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    variants.add(s);
    variants.add(Buffer.from(s).toString("base64"));
    variants.add(Buffer.from(`x-access-token:${s}`).toString("base64"));
  }
  // Longest first so a secret that contains another is replaced whole.
  for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}
