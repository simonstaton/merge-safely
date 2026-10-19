import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Change, Workspace, WorkspaceHandle } from "@merge-safely/core";

const run = promisify(execFile);

type Files = Record<string, string> | ((change: Change) => Record<string, string>);

export interface FakeWorkspaceOptions {
  /** Head contents written into every checkout, or a function of the change (e.g. a fixture's `headFiles`). */
  files?: Files;
  /** Base contents (e.g. a fixture's `baseFiles`), committed before the head so `git_diff` shows the change. */
  baseFiles?: Files;
  /**
   * `git init` with two commits, base (`baseFiles`, or empty) then head (`files`), so git-based tools work and
   * `handle.baseSha` is the real base commit. Default true when `files` or `baseFiles` is given.
   */
  git?: boolean;
  /** Parent directory for checkouts. Default the OS temp dir. */
  baseDir?: string;
}

export interface FakeWorkspaceHandle extends WorkspaceHandle {
  seatId?: string;
  /** The real head commit in the temp repo (differs from `headSha`, which mirrors the change). */
  commitSha?: string;
  disposed: boolean;
}

export interface FakeWorkspace extends Workspace {
  acquire(change: Change, opts?: { seatId?: string }): Promise<FakeWorkspaceHandle>;
  readonly handles: FakeWorkspaceHandle[];
  readonly acquired: number;
  readonly disposed: number;
  /** Handles acquired and not yet disposed. */
  readonly active: number;
  /** Dispose every live handle (use in afterEach). */
  disposeAll(): Promise<void>;
}

// Isolate git from the developer's global config, hooks and signing setup.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "testkit",
  GIT_AUTHOR_EMAIL: "testkit@example.invalid",
  GIT_COMMITTER_NAME: "testkit",
  GIT_COMMITTER_EMAIL: "testkit@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
  });
  return stdout.trim();
}

/** Resolve `path` under `root`, refusing absolute paths and anything that escapes it. */
function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`fake workspace: path escapes the checkout: ${path}`);
  }
  return full;
}

/** A Workspace handing out a fresh temp directory per acquire; dispose removes it. */
export function fakeWorkspace(opts: FakeWorkspaceOptions = {}): FakeWorkspace {
  const handles: FakeWorkspaceHandle[] = [];
  let acquired = 0;
  let disposed = 0;
  const useGit = opts.git ?? (opts.files !== undefined || opts.baseFiles !== undefined);
  const resolveFiles = (f: Files | undefined, change: Change) => (typeof f === "function" ? f(change) : (f ?? {}));

  return {
    handles,
    get acquired() {
      return acquired;
    },
    get disposed() {
      return disposed;
    },
    get active() {
      return acquired - disposed;
    },

    async acquire(change, acquireOpts) {
      const cwd = await mkdtemp(join(opts.baseDir ?? tmpdir(), "merge-safely-ws-"));
      try {
        const head = resolveFiles(opts.files, change);
        const write = async (files: Record<string, string>) => {
          for (const [path, content] of Object.entries(files)) {
            const full = inside(cwd, path);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, content);
          }
        };
        let commitSha: string | undefined;
        let baseCommit: string | undefined;
        if (useGit) {
          const base = resolveFiles(opts.baseFiles, change);
          await git(cwd, ["init", "-q", "-b", change.headRef || "main"]);
          await write(base);
          await git(cwd, ["add", "-A"]);
          await git(cwd, ["commit", "-q", "--allow-empty", "-m", `base of #${change.number}`]);
          baseCommit = await git(cwd, ["rev-parse", "HEAD"]);
          for (const path of Object.keys(base)) if (!Object.hasOwn(head, path)) await rm(inside(cwd, path));
          await write(head);
          await git(cwd, ["add", "-A"]);
          await git(cwd, ["commit", "-q", "--allow-empty", "-m", `head of #${change.number}`]);
          commitSha = await git(cwd, ["rev-parse", "HEAD"]);
        } else {
          await write(head);
        }
        const handle: FakeWorkspaceHandle = {
          cwd,
          headSha: change.headSha,
          // Only a commit that exists in this repo: tools resolve it for git_diff.
          ...(baseCommit ? { baseSha: baseCommit } : {}),
          disposed: false,
          ...(acquireOpts?.seatId ? { seatId: acquireOpts.seatId } : {}),
          ...(commitSha ? { commitSha } : {}),
          async dispose() {
            if (handle.disposed) return;
            handle.disposed = true;
            disposed++;
            await rm(cwd, { recursive: true, force: true });
          },
        };
        acquired++;
        handles.push(handle);
        return handle;
      } catch (err: unknown) {
        await rm(cwd, { recursive: true, force: true });
        throw err;
      }
    },

    async disposeAll() {
      await Promise.all(handles.filter((h) => !h.disposed).map((h) => h.dispose()));
    },
  };
}
