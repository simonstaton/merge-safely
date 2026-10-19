/**
 * Diffs for eval cases: compute a unified diff between two directory trees (fixture cases) and parse a unified
 * diff into the ChangedFile list a SourceProvider would report.
 *
 * Fixture diffs are produced by a throwaway git repository: base/ is committed, head/ replaces the tree and is
 * committed, and `git diff base head` is taken. Commits use fixed identities and dates so the SHAs are stable for a
 * given pair of trees, which keeps eval verdicts reproducible. `materializeTrees` keeps that repository alive so a
 * reviewer workspace can check out the head commit; `diffTrees` disposes it immediately.
 *
 * Every git command runs through workspace-local's hardened `git` helper: a scrubbed environment (no inherited
 * GIT_* variables, so GIT_DIR / GIT_INDEX_FILE from a surrounding hook cannot redirect it), an empty private HOME,
 * no system config and no hooks.
 *
 * Symlinks: the trees must be real directories inside the case directory, and a symlink inside a tree must be a
 * relative link that resolves inside that same tree. Links are copied verbatim (never dereferenced), so nothing
 * from outside the case can reach a prompt and fixture SHAs do not depend on the host path.
 */
import { cp, lstat, mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChangedFile, FileStatus } from "@merge-safely/core";
import { git as hardenedGit } from "@merge-safely/workspace-local";

const COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "merge-safely-evals",
  GIT_AUTHOR_EMAIL: "evals@merge-safely.invalid",
  GIT_COMMITTER_NAME: "merge-safely-evals",
  GIT_COMMITTER_EMAIL: "evals@merge-safely.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const COMMIT_CONFIG: Array<[string, string]> = [
  ["core.autocrlf", "false"],
  ["core.safecrlf", "false"],
  ["core.symlinks", "true"],
  ["commit.gpgsign", "false"],
  ["init.defaultBranch", "main"],
  ["user.name", "merge-safely-evals"],
  ["user.email", "evals@merge-safely.invalid"],
];

/** Files kept only so that git preserves an otherwise empty directory; never part of a fixture's change. */
const PLACEHOLDERS = new Set([".gitkeep"]);

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await hardenedGit(args, { cwd, env: COMMIT_ENV, config: COMMIT_CONFIG, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (exit ${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err: unknown) {
    void err;
    return null;
  }
}

/**
 * Resolve `path` and require it to be inside `confine` (both through realpath). `path` itself must not be a
 * symlink. Returns null when it does not exist.
 */
export async function confinedPath(rawPath: string, confine: string, label: string): Promise<string | null> {
  // resolve() drops a trailing slash, which would otherwise make lstat follow a symlinked directory.
  const path = resolve(rawPath);
  const st = await lstatOrNull(path);
  if (!st) return null;
  if (st.isSymbolicLink()) throw new FixtureError(`${label} is a symlink; fixture trees and diffs must be real files`);
  const real = await realpath(path);
  const root = await realpath(confine);
  if (!within(root, real)) throw new FixtureError(`${label} resolves outside the case directory`);
  return real;
}

/** Reject symlinks inside `root` that are absolute or resolve outside `root`. */
async function checkSymlinks(root: string, label: string, dir = root): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const rel = relative(root, p);
    if (entry.isSymbolicLink()) {
      const target = await readlink(p);
      if (isAbsolute(target)) {
        throw new FixtureError(`${label}/${rel} is a symlink to an absolute path; use a relative link inside the tree`);
      }
      if (!within(root, resolve(dirname(p), target))) {
        throw new FixtureError(`${label}/${rel} is a symlink whose target resolves outside the tree`);
      }
    } else if (entry.isDirectory() && entry.name !== ".git") {
      await checkSymlinks(root, label, p);
    }
  }
}

async function copyTree(from: string | null, to: string): Promise<void> {
  if (!from) return;
  for (const entry of await readdir(from)) {
    if (entry === ".git" || PLACEHOLDERS.has(entry)) continue;
    await cp(join(from, entry), join(to, entry), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) =>
        !relative(from, src)
          .split(/[\\/]/)
          .some((seg) => seg === ".git" || PLACEHOLDERS.has(seg)),
    });
  }
}

async function clearTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

export interface TreeDiff {
  /** Unified diff, base -> head, with `a/` and `b/` prefixes; applies with `git apply` on top of base. */
  diff: string;
  files: ChangedFile[];
  baseSha: string;
  headSha: string;
}

export interface MaterializedRepo extends TreeDiff {
  /** A git repository whose history holds baseSha and headSha (head checked out). */
  repoPath: string;
  /** Remove the repository. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Build a throwaway repository with base and head commits and keep it until `dispose`. A missing tree is an empty
 * tree. `confine` (default: the parent of each tree) bounds where the trees may resolve to.
 */
export async function materializeTrees(
  baseDir: string,
  headDir: string,
  opts: { confine?: string } = {},
): Promise<MaterializedRepo> {
  const base = await confinedPath(baseDir, opts.confine ?? dirname(resolve(baseDir)), "base/");
  const head = await confinedPath(headDir, opts.confine ?? dirname(resolve(headDir)), "head/");
  if (base) await checkSymlinks(base, "base");
  if (head) await checkSymlinks(head, "head");
  const work = await mkdtemp(join(tmpdir(), "merge-safely-evals-"));
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(work, { recursive: true, force: true });
  };
  try {
    await git(work, ["init", "-q"]);
    await copyTree(base, work);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "base"]);
    const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await clearTree(work);
    await copyTree(head, work);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "head"]);
    const headSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    const diff = await git(work, ["diff", "--no-color", "--no-ext-diff", "-M", "--binary", baseSha, headSha]);
    return { diff, files: parseUnifiedDiff(diff), baseSha, headSha, repoPath: work, dispose };
  } catch (err: unknown) {
    await dispose();
    throw err;
  }
}

/** Compute the diff that turns the `baseDir` tree into the `headDir` tree, then discard the repository. */
export async function diffTrees(baseDir: string, headDir: string, opts: { confine?: string } = {}): Promise<TreeDiff> {
  const repo = await materializeTrees(baseDir, headDir, opts);
  await repo.dispose();
  return { diff: repo.diff, files: repo.files, baseSha: repo.baseSha, headSha: repo.headSha };
}

function unquote(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(path);
      if (typeof parsed === "string") return parsed;
    } catch (err: unknown) {
      void err;
    }
  }
  return path;
}

function stripPrefix(path: string): string {
  const p = unquote(path.trim());
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Split `diff --git a/x b/y` into its two paths (handles the common unquoted, space-free and quoted forms). */
function headerPaths(header: string): { from: string; to: string } | null {
  const rest = header.slice("diff --git ".length);
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted?.[1] && quoted[2]) return { from: stripPrefix(quoted[1]), to: stripPrefix(quoted[2]) };
  // Paths with spaces: "a/<p> b/<p>" where both halves are equal for non-renames.
  const mid = rest.indexOf(" b/");
  if (rest.startsWith("a/") && mid > 0) return { from: rest.slice(2, mid), to: rest.slice(mid + 3) };
  return null;
}

/**
 * Parse a unified diff (as produced by `git diff` or GitHub's `.diff` media type) into ChangedFiles.
 * `patch` holds the hunk text from the first `@@`, the same shape GitHub's files API returns.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const paths = headerPaths(line);
    let from = paths?.from ?? "";
    let to = paths?.to ?? "";
    let status: FileStatus = "modified";
    let additions = 0;
    let deletions = 0;
    const hunk: string[] = [];
    let inHunk = false;
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.startsWith("diff --git ")) break;
      if (!inHunk) {
        if (l.startsWith("new file mode")) status = "added";
        else if (l.startsWith("deleted file mode")) status = "removed";
        else if (l.startsWith("rename from ")) {
          from = unquote(l.slice("rename from ".length));
          status = "renamed";
        } else if (l.startsWith("rename to ")) to = unquote(l.slice("rename to ".length));
        else if (l.startsWith("copy from ")) {
          from = unquote(l.slice("copy from ".length));
          status = "copied";
        } else if (l.startsWith("copy to ")) to = unquote(l.slice("copy to ".length));
        else if (l.startsWith("--- ") && l !== "--- /dev/null") from = stripPrefix(l.slice(4));
        else if (l.startsWith("+++ ") && l !== "+++ /dev/null") to = stripPrefix(l.slice(4));
        else if (l.startsWith("@@")) {
          inHunk = true;
          hunk.push(l);
        }
        continue;
      }
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
      hunk.push(l);
    }
    while (hunk.length > 0 && hunk[hunk.length - 1] === "") hunk.pop();
    const path = status === "removed" ? from : to || from;
    const file: ChangedFile = { path, status, additions, deletions };
    if ((status === "renamed" || status === "copied") && from && from !== path) file.previousPath = from;
    if (hunk.length > 0) file.patch = hunk.join("\n");
    files.push(file);
  }
  return files;
}
