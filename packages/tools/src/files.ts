import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, scrubbedEnv } from "./proc.js";

/** Directories never descended into by walks and listings. */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
const WALK_SKIP = new Set([".git", "node_modules"]);
export const MAX_LISTED_FILES = 100_000;

/**
 * Every file in the workspace, relative with `/` separators.
 * Uses `git ls-files` (tracked + untracked, minus ignored) when the root is a git checkout, so
 * .gitignore is respected; otherwise walks the tree skipping .git and node_modules. Symlinked
 * directories are never followed.
 */
export async function listWorkspaceFiles(realRoot: string, signal?: AbortSignal): Promise<string[]> {
  const r = await runProcess(
    "git",
    ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: realRoot,
      env: scrubbedEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }),
      timeoutMs: 60_000,
      maxBytes: 64 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    },
  );
  if (r.code === 0 && !r.spawnError) {
    const seen = new Set<string>();
    for (const p of r.stdout.split("\0")) {
      if (p && !seen.has(p)) seen.add(p);
      if (seen.size >= MAX_LISTED_FILES) break;
    }
    return [...seen].sort();
  }
  return walk(realRoot);
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
