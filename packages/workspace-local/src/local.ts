import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change, Workspace, WorkspaceHandle } from "@merge-safely/core";
import { type GitResult, git, scrubSecrets } from "./git.js";

export interface LocalWorkspaceOptions {
  /** An existing local clone; worktrees are added to it. */
  repoPath?: string;
  /** Remote to mirror into cacheDir when no repoPath is given (https URL or a local path). */
  cloneUrl?: string;
  /** Token for cloneUrl/origin, sent as an http.extraheader via the environment. Never written to disk. */
  token?: string;
  /** Bare mirror location. Default `$TMPDIR/merge-safely/repos/<owner>__<name>.git`. */
  cacheDir?: string;
  /** Shallow fetch depth. Default: full history (git_log and git_blame are more useful). */
  fetchDepth?: number;
  /** Where checkouts are created. Default `$TMPDIR/merge-safely/worktrees`. */
  worktreeRoot?: string;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Serialise git operations per repository so concurrent seats never race on ref or shallow locks. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";
}

/** Create a directory owned by us with 0700, refusing a pre-planted symlink or someone else's dir in shared /tmp. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it`);
  }
}

export function localWorkspace(opts: LocalWorkspaceOptions): Workspace {
  if (!opts.repoPath && !opts.cloneUrl) throw new Error("localWorkspace needs repoPath or cloneUrl");
  const secrets = [opts.token];
  const scrub = (t: string): string => scrubSecrets(t, secrets);
  const base = join(tmpdir(), "merge-safely");
  let hooksDir: Promise<string> | undefined;
  // A private, empty hooks directory: repo hooks (post-checkout etc.) never execute.
  const emptyHooks = (): Promise<string> => {
    hooksDir ??= (async () => {
      await ensurePrivateDir(base);
      return mkdtemp(join(base, "no-hooks-"));
    })();
    return hooksDir;
  };

  /** Token as an env-injected config entry (GIT_CONFIG_COUNT), so it is in neither argv nor any file. */
  const authEnv = (): NodeJS.ProcessEnv => {
    if (!opts.token) return {};
    const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
    let key = "http.extraheader";
    if (opts.cloneUrl && /^https?:\/\//i.test(opts.cloneUrl)) {
      const u = new URL(opts.cloneUrl);
      key = `http.${u.protocol}//${u.host}/.extraheader`;
    }
    return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: key, [`GIT_CONFIG_VALUE_${n}`]: header };
  };

  const run = async (args: string[], cwd: string, what: string): Promise<GitResult> => {
    const hooks = await emptyHooks();
    const r = await git(["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: authEnv(),
    });
    if (r.code !== 0) throw new Error(scrub(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`));
    return r;
  };

  const hasCommit = async (gitDir: string, sha: string): Promise<boolean> => {
    const r = await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: gitDir });
    return r.code === 0;
  };

  /** Ensure `sha` exists in gitDir: fetch it directly, then fall back to the PR head ref. */
  const ensureCommit = async (gitDir: string, remote: string, sha: string, prNumber: number): Promise<void> => {
    if (await hasCommit(gitDir, sha)) return;
    const depth = opts.fetchDepth && opts.fetchDepth > 0 ? [`--depth=${opts.fetchDepth}`] : [];
    const errors: string[] = [];
    try {
      await run(
        ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", ...depth, "--", remote, sha],
        gitDir,
        "git fetch <sha>",
      );
    } catch (e: unknown) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (!(await hasCommit(gitDir, sha)) && prNumber > 0) {
      try {
        await run(
          [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            ...depth,
            "--",
            remote,
            `+refs/pull/${prNumber}/head:refs/merge-safely/pull/${prNumber}`,
          ],
          gitDir,
          "git fetch pull ref",
        );
      } catch (e: unknown) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (!(await hasCommit(gitDir, sha))) {
      throw new Error(
        scrub(`commit ${sha} is not available from ${remote}${errors.length ? `: ${errors.join("; ")}` : ""}`),
      );
    }
  };

  /** The repository worktrees are added to, created/updated as needed, and the remote to fetch from. */
  const source = async (change: Change): Promise<{ gitDir: string; remote: string }> => {
    if (opts.repoPath) return { gitDir: await realpath(opts.repoPath), remote: "origin" };
    const cloneUrl = opts.cloneUrl as string;
    const dir =
      opts.cacheDir ?? join(base, "repos", `${safeName(change.repo.owner)}__${safeName(change.repo.name)}.git`);
    if (!opts.cacheDir) {
      await ensurePrivateDir(base);
      await ensurePrivateDir(join(base, "repos"));
    }
    if (!existsSync(join(dir, "HEAD"))) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await run(["init", "--quiet", "--bare", dir], dir, "git init");
      // The mirror is ours: pin hooks off and avoid background gc racing with live worktrees.
      const hooks = await emptyHooks();
      await run(["config", "core.hooksPath", hooks], dir, "git config");
      await run(["config", "gc.auto", "0"], dir, "git config");
    }
    // Fetch by URL rather than a configured remote so credentials in the URL never land in config.
    return { gitDir: dir, remote: cloneUrl };
  };

  return {
    async acquire(change: Change, acquireOpts?: { seatId?: string }): Promise<WorkspaceHandle> {
      if (!SHA_RE.test(change.headSha)) throw new Error(`headSha is not a commit sha: ${scrub(change.headSha)}`);
      const { gitDir, remote } = await source(change);
      const root = opts.worktreeRoot ?? join(base, "worktrees");
      if (!opts.worktreeRoot) await ensurePrivateDir(base);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const seat = acquireOpts?.seatId ? `-${safeName(acquireOpts.seatId)}` : "";
      const prefix = `${safeName(change.repo.name)}-${change.headSha.slice(0, 12)}${seat}-`;
      const dir = await mkdtemp(join(root, prefix));

      try {
        await withLock(gitDir, async () => {
          await ensureCommit(gitDir, remote, change.headSha, change.number);
          if (change.baseSha && SHA_RE.test(change.baseSha)) {
            // Best effort: git_diff against the base needs it, but review can proceed without.
            await ensureCommit(gitDir, remote, change.baseSha, 0).catch(() => undefined);
          }
          await run(["worktree", "add", "--quiet", "--detach", "--", dir, change.headSha], gitDir, "git worktree add");
        });
      } catch (e: unknown) {
        await rm(dir, { recursive: true, force: true });
        await git(["worktree", "prune"], { cwd: gitDir });
        throw e instanceof Error ? new Error(scrub(e.message)) : new Error(scrub(String(e)));
      }

      const cwd = await realpath(dir);
      let disposed = false;
      const handle: WorkspaceHandle = {
        cwd,
        headSha: change.headSha,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await withLock(gitDir, async () => {
            await git(["worktree", "remove", "--force", "--force", "--", cwd], { cwd: gitDir });
            await rm(cwd, { recursive: true, force: true });
            await git(["worktree", "prune"], { cwd: gitDir });
          });
        },
      };
      if (change.baseSha) handle.baseSha = change.baseSha;
      return handle;
    },
  };
}
