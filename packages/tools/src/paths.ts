import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathError extends Error {}

export interface SafePath {
  /** Absolute, symlink-resolved path (of the nearest existing ancestor when the path does not exist). */
  abs: string;
  /** Path relative to the workspace root, with `/` separators. "." for the root itself. */
  rel: string;
  exists: boolean;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

function hasGitSegment(rel: string): boolean {
  return rel.split("/").some((s) => s.toLowerCase() === ".git");
}

/**
 * Resolve a model-supplied path against the workspace root.
 * Rejects `..` escapes, symlinks resolving outside the root, and anything under `.git`
 * (git internals are only reachable through the git tools).
 * `realRoot` must already be realpath'd.
 */
export function resolveSafe(realRoot: string, input: string | undefined, opts: { mustExist?: boolean } = {}): SafePath {
  const raw = (input ?? ".").trim() || ".";
  if (raw.includes("\0")) throw new PathError("path contains a NUL byte");
  const lexical = resolve(realRoot, raw);
  if (!isInside(realRoot, lexical)) throw new PathError(`path escapes the workspace: ${raw}`);
  const lexRel = toPosix(relative(realRoot, lexical)) || ".";
  if (hasGitSegment(lexRel)) throw new PathError(".git internals are not readable; use git_diff, git_log or git_blame");

  // Resolve symlinks on the nearest existing ancestor so a non-existent leaf cannot hide an escape.
  let probe = lexical;
  let suffix = "";
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    suffix = suffix ? `${probe.slice(parent.length + 1)}${sep}${suffix}` : probe.slice(parent.length + 1);
    probe = parent;
  }
  const exists = suffix === "";
  if (!exists && opts.mustExist) throw new PathError(`no such file or directory: ${lexRel}`);
  let real: string;
  try {
    real = realpathSync.native(probe);
  } catch {
    throw new PathError(`cannot resolve path: ${lexRel}`);
  }
  if (!isInside(realRoot, real)) throw new PathError(`path resolves outside the workspace (symlink): ${lexRel}`);
  const realRel = toPosix(relative(realRoot, real)) || ".";
  if (hasGitSegment(realRel))
    throw new PathError(".git internals are not readable; use git_diff, git_log or git_blame");
  return { abs: suffix ? resolve(real, suffix) : real, rel: lexRel, exists };
}

/** Root realpath, so later containment checks compare like with like (e.g. /tmp -> /private/tmp). */
export function realRootOf(cwd: string): string {
  return realpathSync.native(cwd);
}
