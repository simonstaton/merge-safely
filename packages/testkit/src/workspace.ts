import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Change, Workspace, WorkspaceHandle } from "@merge-safely/core";

const run = promisify(execFile);

export interface FakeWorkspaceOptions {
  /** Files to write into every checkout, or a function of the change (e.g. a fixture's head contents). */
  files?: Record<string, string> | ((change: Change) => Record<string, string>);
  /** `git init` and commit the files so git-based tools work. Default true when `files` is given. */
  git?: boolean;
  /** Parent directory for checkouts. Default the OS temp dir. */
  baseDir?: string;
}

export interface FakeWorkspaceHandle extends WorkspaceHandle {
  seatId?: string;
  /** The real commit in the temp repo (differs from `headSha`, which mirrors the change). */
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
  const useGit = opts.git ?? opts.files !== undefined;

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
        const files = typeof opts.files === "function" ? opts.files(change) : (opts.files ?? {});
        for (const [path, content] of Object.entries(files)) {
          const full = inside(cwd, path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, content);
        }
        let commitSha: string | undefined;
        if (useGit) {
          await git(cwd, ["init", "-q", "-b", change.headRef || "main"]);
          await git(cwd, ["add", "-A"]);
          await git(cwd, ["commit", "-q", "--allow-empty", "-m", `fixture for #${change.number}`]);
          commitSha = await git(cwd, ["rev-parse", "HEAD"]);
        }
        const handle: FakeWorkspaceHandle = {
          cwd,
          headSha: change.headSha,
          baseSha: change.baseSha,
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
