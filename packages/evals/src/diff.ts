/**
 * Diffs for eval cases: compute a unified diff between two directory trees (fixture cases) and parse a unified
 * diff into the ChangedFile list a SourceProvider would report.
 *
 * Fixture diffs are produced by a throwaway git repository: base/ is committed, head/ replaces the tree and is
 * committed, and `git diff base head` is taken. Commits use fixed identities and dates so the SHAs are stable for a
 * given pair of trees, which keeps eval verdicts reproducible.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, FileStatus } from "@merge-safely/core";

const exec = promisify(execFile);

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "merge-safely-evals",
  GIT_AUTHOR_EMAIL: "evals@merge-safely.invalid",
  GIT_COMMITTER_NAME: "merge-safely-evals",
  GIT_COMMITTER_EMAIL: "evals@merge-safely.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const GIT_FLAGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "core.hooksPath=/dev/null",
];

/** Files kept only so that git preserves an otherwise empty directory; never part of a fixture's change. */
const PLACEHOLDERS = new Set([".gitkeep"]);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...GIT_FLAGS, ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV, HOME: cwd, XDG_CONFIG_HOME: cwd },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err: unknown) {
    void err;
    return false;
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  if (!(await isDir(from))) return;
  for (const entry of await readdir(from)) {
    if (entry === ".git" || PLACEHOLDERS.has(entry)) continue;
    await cp(join(from, entry), join(to, entry), {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).some((seg) => seg === ".git" || PLACEHOLDERS.has(seg)),
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

/** Compute the diff that turns the `baseDir` tree into the `headDir` tree. A missing directory is an empty tree. */
export async function diffTrees(baseDir: string, headDir: string): Promise<TreeDiff> {
  const work = await mkdtemp(join(tmpdir(), "merge-safely-evals-"));
  try {
    await git(work, ["init", "-q"]);
    await copyTree(baseDir, work);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await clearTree(work);
    await copyTree(headDir, work);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "--allow-empty", "-m", "head"]);
    const headSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    const diff = await git(work, ["diff", "--no-color", "--no-ext-diff", "-M", "--binary", baseSha, headSha]);
    return { diff, files: parseUnifiedDiff(diff), baseSha, headSha };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
