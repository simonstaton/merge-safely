import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Change, Workspace, WorkspaceHandle } from "@merge-safely/core";
import { type GitResult, git, privateGitDirs, scrubSecrets } from "./git.js";

export interface LocalWorkspaceOptions {
  /**
   * An existing local clone; worktrees are added to it. For local use on the user's OWN repository
   * only (e.g. `merge-safely run --local` against a PR). The worktree's `.git` links back into this
   * repo, so never combine it with `allowedCommands` on untrusted PRs. PR review in CI must use
   * `cloneUrl` (mirror mode) or a container workspace.
   */
  repoPath?: string;
  /** Remote to mirror into cacheDir when no repoPath is given (https URL or a local path). */
  cloneUrl?: string;
  /**
   * Token for cloneUrl/origin. Sent as an http.extraheader scoped to that URL, via the environment,
   * on fetch commands only. Never in argv, never written to disk, scrubbed from errors.
   */
  token?: string;
  /** Bare mirror location. Default `$TMPDIR/merge-safely/repos/<owner>__<name>.git`. */
  cacheDir?: string;
  /** Shallow fetch depth. Default: full history (git_log and git_blame are more useful). */
  fetchDepth?: number;
  /** Where checkouts are created. Default `$TMPDIR/merge-safely/worktrees`. */
  worktreeRoot?: string;
  /**
   * repoPath mode: let fetches use the user's HOME (global config, credential helpers, ssh config).
   * All other git commands still run with an empty private HOME. Default false.
   */
  inheritGitCredentials?: boolean;
  /** Extra git config for fetch commands (e.g. `http.proxy`). Passed via the environment. */
  gitConfig?: Record<string, string>;
}

/** Full object ids only: an abbreviated sha is ambiguous, especially in a mirror shared across forks. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Mirror config keys we write or git init writes. Anything else means someone else wrote to it. */
const MIRROR_CONFIG_ALLOWED = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.hookspath",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.logallrefupdates",
  "gc.auto",
  "extensions.objectformat",
]);

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

/** Create (or take over) a 0700 directory we own; refuse a pre-planted symlink or someone else's dir. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/** rm -rf that also copes with PR code having chmod'ed directories read-only. */
async function forceRemove(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // restore permissions and retry below
  }
  const fix = async (d: string): Promise<void> => {
    try {
      await chmod(d, 0o700);
      for (const e of await readdir(d, { withFileTypes: true })) if (e.isDirectory()) await fix(join(d, e.name));
    } catch {
      // best effort
    }
  };
  await fix(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Split userinfo out of an http(s) URL so credentials never reach argv. */
export function splitUrlCredentials(url: string): { url: string; basic?: string } {
  if (!/^https?:\/\//i.test(url)) return { url };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url };
  }
  if (!u.username && !u.password) return { url };
  const basic = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  u.username = "";
  u.password = "";
  return { url: u.toString(), basic };
}

function isLocalPath(remote: string): boolean {
  return isAbsolute(remote) || remote.startsWith("file://") || remote.startsWith("./") || remote.startsWith("../");
}

export function localWorkspace(opts: LocalWorkspaceOptions): Workspace {
  if (!opts.repoPath && !opts.cloneUrl) throw new Error("localWorkspace needs repoPath or cloneUrl");
  const split = opts.cloneUrl ? splitUrlCredentials(opts.cloneUrl) : undefined;
  const urlPassword = split?.basic
    ? Buffer.from(split.basic, "base64").toString("utf8").split(":").slice(1).join(":")
    : "";
  const scrub = (t: string): string => scrubSecrets(t, [opts.token, split?.basic, urlPassword]);
  const base = join(tmpdir(), "merge-safely");
  const mirrorDir = (change: Change): string =>
    opts.cacheDir ?? join(base, "repos", `${safeName(change.repo.owner)}__${safeName(change.repo.name)}.git`);
  /** One lock per underlying repository, shared by acquire and dispose. */
  const lockKey = (change: Change): string => (opts.repoPath ? resolve(opts.repoPath) : resolve(mirrorDir(change)));

  /** Run a local (non-network) git command: hardening only, no credentials, no protocols. */
  const runLocal = async (
    args: string[],
    cwd: string,
    what: string,
    env?: Record<string, string>,
  ): Promise<GitResult> => {
    const r = await git(args, { cwd, ...(env ? { env } : {}) });
    if (r.code !== 0) throw new Error(scrub(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`));
    return r;
  };

  /**
   * Config for a fetch from `remote`: the protocols it needs, and the auth header scoped to that URL.
   * Only fetch commands ever see credentials.
   */
  const fetchConfig = (remote: string): Array<[string, string]> => {
    const cfg: Array<[string, string]> = [
      ["protocol.https.allow", "always"],
      ["protocol.ssh.allow", "always"],
    ];
    if (isLocalPath(remote)) cfg.push(["protocol.file.allow", "always"]);
    const basic = opts.token
      ? Buffer.from(`x-access-token:${opts.token}`).toString("base64")
      : remote === split?.url
        ? split.basic
        : undefined;
    if (basic && /^https?:\/\//i.test(remote))
      cfg.push([`http.${remote}.extraheader`, `AUTHORIZATION: basic ${basic}`]);
    for (const [k, v] of Object.entries(opts.gitConfig ?? {})) cfg.push([k, v]);
    return cfg;
  };

  const runFetch = async (args: string[], gitDir: string, remote: string, what: string): Promise<void> => {
    const r = await git(args, {
      cwd: gitDir,
      config: fetchConfig(remote),
      inheritHome: opts.inheritGitCredentials === true && Boolean(opts.repoPath),
    });
    if (r.code !== 0) throw new Error(scrub(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`));
  };

  const hasCommit = async (gitDir: string, sha: string): Promise<boolean> =>
    (await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: gitDir })).code === 0;

  /** Ensure `sha` exists in gitDir: fetch it directly, then fall back to the PR head ref. */
  const ensureCommit = async (gitDir: string, remote: string, sha: string, prNumber: number): Promise<void> => {
    if (await hasCommit(gitDir, sha)) return;
    const depth = opts.fetchDepth && opts.fetchDepth > 0 ? [`--depth=${opts.fetchDepth}`] : [];
    const common = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", ...depth];
    const errors: string[] = [];
    try {
      await runFetch([...common, "--", remote, sha], gitDir, remote, "git fetch <sha>");
    } catch (e: unknown) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (!(await hasCommit(gitDir, sha)) && prNumber > 0) {
      try {
        const refspec = `+refs/pull/${prNumber}/head:refs/merge-safely/pull/${prNumber}`;
        await runFetch([...common, "--", remote, refspec], gitDir, remote, "git fetch pull ref");
      } catch (e: unknown) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (!(await hasCommit(gitDir, sha))) {
      const where = remote === "origin" ? "origin" : (split?.url ?? remote);
      throw new Error(
        scrub(`commit ${sha} is not available from ${where}${errors.length ? `: ${errors.join("; ")}` : ""}`),
      );
    }
  };

  /**
   * The mirror is ours alone. PR code run by an allowlisted command can reach it through the
   * worktree's gitfile; if its config or attributes were touched, rebuild it (or refuse while other
   * seats still have live worktrees in it).
   */
  const checkMirror = async (dir: string): Promise<void> => {
    if (!existsSync(join(dir, "HEAD"))) return;
    const r = await git(["config", "--file", join(dir, "config"), "--name-only", "--list"], { cwd: dir });
    const keys = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : ["<unreadable>"];
    const badKey = keys.find((k) => !MIRROR_CONFIG_ALLOWED.has(k.toLowerCase()));
    const badFile = ["info/attributes", "objects/info/alternates", "config.worktree", "commondir"].find((f) =>
      existsSync(join(dir, f)),
    );
    if (!badKey && !badFile) return;
    const wt = await git(["worktree", "list", "--porcelain"], { cwd: dir });
    const live = wt.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
    if (live > 0) {
      throw new Error(
        `mirror ${dir} was modified (${badKey ?? badFile}) while ${live} worktree(s) are live; refusing to use it`,
      );
    }
    await forceRemove(dir);
  };

  /** The repository worktrees are added to, created/validated as needed, and the remote to fetch from. */
  const source = async (change: Change): Promise<{ gitDir: string; remote: string }> => {
    if (opts.repoPath) {
      const gitDir = await realpath(opts.repoPath);
      const url = (await git(["config", "--get", "remote.origin.url"], { cwd: gitDir })).stdout.trim();
      // Fetch by URL when it is http(s) (so the auth header is scoped to it) or a local path (so the file
      // protocol is enabled only for it); otherwise (ssh) by remote name.
      if (url && /^https?:\/\//i.test(url)) return { gitDir, remote: splitUrlCredentials(url).url };
      if (url && isLocalPath(url)) return { gitDir, remote: url };
      return { gitDir, remote: "origin" };
    }
    const remote = split?.url as string;
    const dir = mirrorDir(change);
    if (!opts.cacheDir) {
      await ensurePrivateDir(base);
      await ensurePrivateDir(join(base, "repos"));
    }
    await checkMirror(dir);
    if (!existsSync(join(dir, "HEAD"))) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await runLocal(["init", "--quiet", "--bare", dir], dir, "git init");
      await runLocal(["config", "core.hooksPath", privateGitDirs().hooks], dir, "git config");
      await runLocal(["config", "gc.auto", "0"], dir, "git config");
    }
    // Fetch by URL rather than a configured remote so neither URL nor credentials land in config.
    return { gitDir: dir, remote };
  };

  return {
    async acquire(change: Change, acquireOpts?: { seatId?: string }): Promise<WorkspaceHandle> {
      if (!SHA_RE.test(change.headSha)) {
        throw new Error(`headSha must be a full 40/64-character commit sha: ${scrub(change.headSha)}`);
      }
      const root = opts.worktreeRoot ?? join(base, "worktrees");
      if (!opts.worktreeRoot) await ensurePrivateDir(base);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const seat = acquireOpts?.seatId ? `-${safeName(acquireOpts.seatId)}` : "";
      const prefix = `${safeName(change.repo.name)}-${change.headSha.slice(0, 12)}${seat}-`;

      let gitDir = "";
      let dir = "";
      try {
        await withLock(lockKey(change), async () => {
          const src = await source(change);
          gitDir = src.gitDir;
          await ensureCommit(gitDir, src.remote, change.headSha, change.number);
          if (change.baseSha && SHA_RE.test(change.baseSha)) {
            // Best effort: git_diff against the base needs it, but review can proceed without.
            await ensureCommit(gitDir, src.remote, change.baseSha, 0).catch(() => undefined);
          }
          dir = await mkdtemp(join(root, prefix));
          // Checkout of attacker content: no credentials, no LFS smudge, no submodules, no protocols.
          await runLocal(
            ["worktree", "add", "--quiet", "--detach", "--", dir, change.headSha],
            gitDir,
            "git worktree add",
            { GIT_LFS_SKIP_SMUDGE: "1" },
          );
        });
      } catch (e: unknown) {
        if (dir) await forceRemove(dir).catch(() => undefined);
        if (gitDir) await git(["worktree", "prune"], { cwd: gitDir });
        throw new Error(scrub(e instanceof Error ? e.message : String(e)));
      }

      const cwd = await realpath(dir);
      let inFlight: Promise<void> | undefined;
      let done = false;
      const handle: WorkspaceHandle = {
        cwd,
        headSha: change.headSha,
        // Idempotent and retryable: concurrent calls share one attempt; a failed attempt can be retried.
        dispose: () => {
          if (done) return Promise.resolve();
          inFlight ??= withLock(lockKey(change), async () => {
            await git(["worktree", "remove", "--force", "--force", "--", cwd], { cwd: gitDir });
            await forceRemove(cwd);
            await git(["worktree", "prune"], { cwd: gitDir });
          }).then(
            () => {
              done = true;
            },
            (e: unknown) => {
              inFlight = undefined;
              throw e;
            },
          );
          return inFlight;
        },
      };
      if (change.baseSha) handle.baseSha = change.baseSha;
      return handle;
    },
  };
}
