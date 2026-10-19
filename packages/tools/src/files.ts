import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runGit, type ToolContext } from "./ctx.js";
import { isHiddenPath } from "./sensitive.js";

/** Directories never descended into by walks and listings. */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
const WALK_SKIP = new Set([".git", "node_modules"]);
export const MAX_LISTED_FILES = 100_000;

function splitZ(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

/**
 * Every file the tools may surface, relative with `/` separators: tracked files plus untracked files
 * that are not git-ignored (so a developer's ignored `.env` or build output never shows up), minus
 * anything under `.git` or credential-shaped. Falls back to a walk when the root is not a git
 * checkout. Symlinked directories are never followed.
 */
export async function listWorkspaceFiles(ctx: ToolContext, signal?: AbortSignal): Promise<string[]> {
  const r = await runGit(ctx, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    timeoutMs: 60_000,
    maxBytes: 64 * 1024 * 1024,
    signal,
  });
  let files: string[];
  if (r.code === 0 && !r.spawnError) {
    files = [...new Set(splitZ(r.stdout))].slice(0, MAX_LISTED_FILES).sort();
  } else {
    files = await walk(ctx.realRoot);
  }
  return files.filter((f) => !isHiddenPath(f));
}

/**
 * Untracked, git-ignored paths. Whole ignored directories are reported once with a trailing `/`.
 * Empty when the root is not a git checkout.
 */
export async function ignoredPaths(ctx: ToolContext, signal?: AbortSignal): Promise<Set<string>> {
  const r = await runGit(
    ctx,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
    { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024, signal },
  );
  if (r.code !== 0 || r.spawnError) return new Set();
  return new Set(splitZ(r.stdout));
}

/** True when rel (a file or directory) is ignored-and-untracked, directly or via an ignored ancestor dir. */
export function isIgnored(rel: string, ignored: ReadonlySet<string>): boolean {
  if (ignored.size === 0 || rel === ".") return false;
  if (ignored.has(rel) || ignored.has(`${rel}/`)) return true;
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (ignored.has(`${parts.slice(0, i).join("/")}/`)) return true;
  }
  return false;
}

async function walk(realRoot: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < MAX_LISTED_FILES) {
    const rel = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(realRoot, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) stack.push(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** True when the buffer looks binary (contains a NUL byte in the first 8 KiB). */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}
