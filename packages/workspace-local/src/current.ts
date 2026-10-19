import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Change, Workspace, WorkspaceHandle } from "@merge-safely/core";
import { git } from "./git.js";

/** Sentinel headSha for a working tree with uncommitted changes. */
export const WORKTREE_SHA = "WORKTREE";

/**
 * The working tree as-is, for `merge-safely run --local`: no checkout, dispose is a no-op.
 * headSha is HEAD, or "WORKTREE" with `dirty: true` when there are uncommitted changes
 * (or when cwd is not a git repository).
 */
export function currentTreeWorkspace(cwd: string): Workspace {
  return {
    async acquire(change: Change): Promise<WorkspaceHandle> {
      const dir = await realpath(resolve(cwd));
      const head = await git(["rev-parse", "--verify", "HEAD"], { cwd: dir, timeoutMs: 30_000 });
      const status = await git(["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], {
        cwd: dir,
        timeoutMs: 60_000,
      });
      const clean = head.code === 0 && status.code === 0 && status.stdout.trim() === "";
      const handle: WorkspaceHandle = {
        cwd: dir,
        headSha: clean ? head.stdout.trim() : WORKTREE_SHA,
        dispose: async () => {},
      };
      if (!clean) handle.dirty = true;
      if (change.baseSha) handle.baseSha = change.baseSha;
      return handle;
    },
  };
}
