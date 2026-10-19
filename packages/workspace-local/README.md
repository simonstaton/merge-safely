# @merge-safely/workspace-local

Workspace adapters that give each reviewer seat its own disposable checkout of the PR head.

```ts
import { localWorkspace, currentTreeWorkspace } from "@merge-safely/workspace-local";

// PR review (CI, app): bare mirror cache + detached worktree per seat.
const ws = localWorkspace({ cloneUrl: "https://github.com/acme/app.git", token });
const handle = await ws.acquire(change, { seatId: "hunter-1" });
try { /* run tools in handle.cwd */ } finally { await handle.dispose(); }

// merge-safely run --local: the working tree as-is.
const here = currentTreeWorkspace(process.cwd()); // headSha "WORKTREE" + dirty: true when uncommitted changes
```

## Modes

- **`cloneUrl` (mirror mode): use this for PR review.**
  - A bare mirror lives in `cacheDir`. It is fetched by URL, so no remote, URL or credential is ever stored in its config.
  - URL userinfo is stripped and sent as a header instead.
  - Before each use, the mirror's config and `info/attributes` are checked. If anything was planted (for example a smudge filter written by PR code), the mirror is rebuilt. While other seats are live, it is refused instead.
- **`repoPath`: only for `--local` use on the user's own repository.** The worktree's `.git` links back into that repository, so PR code started by `allowedCommands` could write its hooks or config. Never use it for untrusted PRs.
- **Container / remote sandbox workspaces** are required for untrusted forks when commands are allowed.

## git hardening

Every git invocation, including through the exported `git()` helper:

- **Environment.** It starts from an allowlist: PATH (absolute entries only), LANG, LC_ALL, TZ, SSH_AUTH_SOCK and SSH_AGENT_PID. No `GIT_*` from the caller, so a pre-commit hook's `GIT_INDEX_FILE` cannot be rewritten. HOME is an empty private dir, plus `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1` and `GIT_TERMINAL_PROMPT=0`.
- **Pinned config**, set through `GIT_CONFIG_COUNT`: `core.hooksPath=<empty dir>`, `core.fsmonitor=false`, `diff.external=` (empty, so external diffs fail closed), `core.pager=cat`, `core.sshCommand=ssh`, `protocol.allow=never`, `submodule.recurse=false`, `credential.helper=`.
- **Fetches.** Only fetch commands re-enable `https`/`ssh` (and `file` for a local remote). Only they carry the token, as `http.<remote-url>.extraheader`, through the environment: never in argv, never on disk, scrubbed from errors. `inheritGitCredentials: true` lets repoPath fetches use the user's HOME.
- **`worktree add`** runs with no credentials and with `GIT_LFS_SKIP_SMUDGE=1`.
- **SHAs.** Only full 40- or 64-character commit SHAs are accepted.
- **`dispose()`** is idempotent, shares one attempt between concurrent callers, retries after a failure, and copes with directories that PR code made read-only.
