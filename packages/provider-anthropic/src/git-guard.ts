import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Guard for the `ms-git` wrapper the CLI runner puts on the reviewer's PATH. Raw `git` is never exposed: options
 * such as `--output=<file>` write anywhere, `--no-index` reads outside the checkout, and `--ext-diff`/`--textconv`
 * run programs. Only diff/log/blame/show are accepted, flags come from a fixed allowlist, every revision is resolved
 * to a commit SHA before git sees it, and paths must stay inside the workspace.
 */

export const GIT_SUBCOMMANDS = ["diff", "log", "blame", "show"] as const;
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

export class GitGuardError extends Error {}

const SAFE_FLAGS = new Set(["--stat", "-p", "--oneline", "--follow", "--name-only", "--name-status", "--no-color"]);
const SAFE_FLAG_PATTERNS: RegExp[] = [/^-n\d{1,6}$/, /^-\d{1,6}$/, /^--max-count=\d{1,6}$/, /^-U\d{1,4}$/];
/** Called out by name so the model gets a clear reason; anything else unlisted is rejected generically. */
const FORBIDDEN_FLAGS = ["--output", "--no-index", "--ext-diff", "--textconv", "-O", "--exec", "--upload-pack"];
const NAMED_FORMATS = new Set(["oneline", "short", "medium", "full", "fuller"]);
/** `%` placeholders allowed in --format/--pretty: hashes, author/committer name and dates, subject, body, newline. */
const SAFE_PLACEHOLDERS = [
  "an",
  "ae",
  "ad",
  "ar",
  "aI",
  "cn",
  "cd",
  "cr",
  "cI",
  "H",
  "h",
  "T",
  "t",
  "P",
  "p",
  "s",
  "b",
  "n",
  "%",
];
const FORBIDDEN_REVISION = /@\{|:\/|\^\{\//;

/** Fixed config: no hooks, no external diff, no pager, no fsmonitor, no colour. */
export const GIT_SAFE_CONFIG = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=never",
];

/** Environment for every git process: literal pathspecs, no prompts, no repo redirection from the caller. */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return {
    ...env,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export type ResolveCommit = (rev: string) => string | undefined;

/** Resolve a revision to a commit SHA with `git rev-parse --verify <rev>^{commit}`, or undefined. */
export function gitResolver(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolveCommit {
  return (rev) => {
    if (!rev || rev.startsWith("-") || FORBIDDEN_REVISION.test(rev) || /[\0\s]/.test(rev)) return undefined;
    try {
      const out = execFileSync(
        "git",
        [...GIT_SAFE_CONFIG, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
        { cwd, env: gitEnv(env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
      ).trim();
      return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
    } catch {
      return undefined;
    }
  };
}

function checkPath(cwd: string, p: string): string {
  if (!p || p.includes("\0")) throw new GitGuardError("empty or invalid path");
  const rel = relative(cwd, resolve(cwd, p));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new GitGuardError(`path is outside the workspace: ${p}`);
  return rel || ".";
}

function checkFormat(value: string): void {
  if (NAMED_FORMATS.has(value)) return;
  const body = value.replace(/^t?format:/, "");
  for (let i = body.indexOf("%"); i !== -1; i = body.indexOf("%", i + 1)) {
    const rest = body.slice(i + 1);
    const ph = SAFE_PLACEHOLDERS.find((p) => rest.startsWith(p));
    if (!ph) throw new GitGuardError(`format placeholder not allowed: %${rest.slice(0, 2)}`);
    i += ph.length;
  }
}

function checkFlag(cwd: string, sub: GitSubcommand, flag: string): string {
  const name = flag.split("=")[0] ?? flag;
  if (FORBIDDEN_FLAGS.some((f) => name === f || (f === "-O" && flag.startsWith("-O")))) {
    throw new GitGuardError(`option not allowed: ${name}`);
  }
  if (SAFE_FLAGS.has(flag) || SAFE_FLAG_PATTERNS.some((re) => re.test(flag))) return flag;
  const fmt = flag.match(/^--(format|pretty)=(.*)$/s);
  if (fmt) {
    checkFormat(fmt[2] ?? "");
    return flag;
  }
  const range = flag.match(/^-L(\d{1,7}),([+-]?\d{1,7})(?::(.+))?$/s);
  if (range && (sub === "blame" || sub === "log")) {
    if (range[3] !== undefined) return `-L${range[1]},${range[2]}:${checkPath(cwd, range[3])}`;
    if (sub === "log") throw new GitGuardError("log -L needs a file: -L<start>,<end>:<path>");
    return flag;
  }
  throw new GitGuardError(
    `option not allowed: ${flag}. Allowed: --stat -p --oneline -n<N> --max-count=<N> -L<start>,<end> --follow --name-only --name-status -U<N> --no-color --format=/--pretty= (safe placeholders)`,
  );
}

/**
 * Turn the model's `ms-git` argv into the exact argv for git. Throws GitGuardError on anything not allowed.
 * Non-option tokens are revisions (resolved to SHAs; ranges a..b / a...b; `show <rev>:<path>`) or, failing that,
 * existing paths inside the workspace. Everything after `--` is a path.
 */
export function planGit(argv: readonly string[], cwd: string, resolveCommit: ResolveCommit): string[] {
  const [subRaw, ...rest] = argv;
  if (!subRaw || !(GIT_SUBCOMMANDS as readonly string[]).includes(subRaw)) {
    throw new GitGuardError(`subcommand not allowed: ${subRaw ?? "(none)"}. Use one of: ${GIT_SUBCOMMANDS.join(", ")}`);
  }
  const sub = subRaw as GitSubcommand;
  const flags: string[] = [];
  const revs: string[] = [];
  const paths: string[] = [];
  let afterDashDash = false;

  const mustResolve = (rev: string, what = rev): string => {
    if (FORBIDDEN_REVISION.test(rev)) throw new GitGuardError(`revision syntax not allowed: ${what}`);
    const sha = resolveCommit(rev);
    if (!sha) throw new GitGuardError(`unknown revision: ${what}`);
    return sha;
  };

  for (const tok of rest) {
    if (afterDashDash) {
      paths.push(checkPath(cwd, tok));
      continue;
    }
    if (tok === "--") {
      afterDashDash = true;
      continue;
    }
    if (tok.startsWith("-")) {
      flags.push(checkFlag(cwd, sub, tok));
      continue;
    }
    if (FORBIDDEN_REVISION.test(tok)) throw new GitGuardError(`revision syntax not allowed: ${tok}`);
    const rangeMatch = tok.match(/^([^.]*?)(\.\.\.?)([^.]*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[3])) {
      const a = mustResolve(rangeMatch[1] || "HEAD", tok);
      const b = mustResolve(rangeMatch[3] || "HEAD", tok);
      revs.push(`${a}${rangeMatch[2]}${b}`);
      continue;
    }
    const colon = tok.indexOf(":");
    if (sub === "show" && colon > 0) {
      revs.push(`${mustResolve(tok.slice(0, colon), tok)}:${checkPath(cwd, tok.slice(colon + 1))}`);
      continue;
    }
    const sha = resolveCommit(tok);
    if (sha) {
      revs.push(sha);
      continue;
    }
    const p = checkPath(cwd, tok);
    if (!existsSync(resolve(cwd, p))) throw new GitGuardError(`unknown revision or path: ${tok}`);
    paths.push(p);
  }

  const hardening = sub === "blame" ? ["--no-textconv"] : ["--no-ext-diff", "--no-textconv"];
  return [...GIT_SAFE_CONFIG, sub, ...hardening, ...flags, ...revs, "--", ...paths];
}

/** Run the wrapper: plan, then exec git with cwd pinned to the workspace. Returns the exit code. */
export function runGitWrapper(
  argv: readonly string[],
  cwd: string,
  io: { stderr: (s: string) => void } = { stderr: (s) => process.stderr.write(s) },
  env: NodeJS.ProcessEnv = process.env,
): number {
  let args: string[];
  try {
    args = planGit(argv, cwd, gitResolver(cwd, env));
  } catch (err: unknown) {
    io.stderr(`ms-git: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const r = spawnSync("git", args, { cwd, env: gitEnv(env), stdio: ["ignore", "inherit", "inherit"], timeout: 60_000 });
  if (r.error) {
    io.stderr(`ms-git: git failed to start: ${r.error.message}\n`);
    return 127;
  }
  return r.status ?? 1;
}
