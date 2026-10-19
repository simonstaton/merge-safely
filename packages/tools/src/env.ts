import { accessSync, constants, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

/**
 * PATH reduced to absolute directories that are not inside the checkout (compared after realpath).
 * Relative entries (`.`, empty, `node_modules/.bin`) would resolve against the PR checkout and let a
 * PR plant `git`, `rg` or `npm`; they are dropped.
 */
export function safePathDirs(realRoot: string, pathEnv: string | undefined = process.env.PATH): string[] {
  const out: string[] = [];
  for (const raw of (pathEnv ?? "").split(delimiter)) {
    if (!raw || !isAbsolute(raw)) continue;
    let real: string;
    try {
      real = realpathSync.native(raw);
    } catch {
      continue;
    }
    if (inside(realRoot, real)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Resolve a bare command name to an absolute executable using only safe PATH dirs. */
export function resolveBinary(name: string, realRoot: string, dirs: readonly string[]): string | undefined {
  if (!name || name.includes("/") || name.includes("\\")) return undefined;
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      // The binary itself (or a symlink chain) must not live in the checkout either.
      if (inside(realRoot, realpathSync.native(candidate))) continue;
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

let privateHome: string | undefined;
/** An empty private directory used as HOME for git so no user/global config or credentials apply. */
export function emptyHome(): string {
  privateHome ??= mkdtempSync(join(tmpdir(), "merge-safely-home-"));
  return privateHome;
}

/** Variables passed through to git from the parent; everything else (incl. every GIT_*) is dropped. */
export const GIT_ENV_PASSTHROUGH = ["LANG", "LC_ALL", "TZ", "SSH_AUTH_SOCK", "SSH_AGENT_PID"] as const;

export function gitEnv(pathDirs: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of GIT_ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    PATH: pathDirs.join(delimiter),
    HOME: emptyHome(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    // Paths are plain paths, never pathspec magic such as ":(top)" or globs.
    GIT_LITERAL_PATHSPECS: "1",
  };
}

/** Variables run_command passes through from the parent. HOME/TMPDIR/XDG_* are replaced per call. */
export const COMMAND_ENV_PASSTHROUGH = ["LANG", "CI", "NODE_ENV"] as const;

export function commandEnv(pathDirs: readonly string[], scratch: { home: string; tmp: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of COMMAND_ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    PATH: pathDirs.join(delimiter),
    HOME: scratch.home,
    XDG_CONFIG_HOME: join(scratch.home, ".config"),
    XDG_CACHE_HOME: join(scratch.home, ".cache"),
    XDG_DATA_HOME: join(scratch.home, ".local", "share"),
    XDG_STATE_HOME: join(scratch.home, ".local", "state"),
    TMPDIR: scratch.tmp,
    TMP: scratch.tmp,
    TEMP: scratch.tmp,
  };
}
