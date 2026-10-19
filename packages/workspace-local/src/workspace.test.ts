import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "@merge-safely/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentTreeWorkspace, WORKTREE_SHA } from "./current.js";
import { git, scrubSecrets } from "./git.js";
import { localWorkspace, splitUrlCredentials } from "./local.js";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let base: string;
let origin: string;
let clone: string;
let baseSha: string;
let headSha: string;
let prOnlySha: string;
let hookMarker: string;

function change(over: Partial<Change> = {}): Change {
  return {
    repo: { host: "github.com", owner: "acme", name: "demo" },
    number: 7,
    headSha,
    baseSha,
    baseRef: "main",
    headRef: "feature",
    title: "t",
    body: "b",
    author: { kind: "human", login: "dev" },
    files: [],
    stats: { additions: 0, deletions: 0, files: 0 },
    labels: [],
    draft: false,
    ciStatus: "success",
    ...over,
  };
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ms-ws-")));
  origin = join(base, "origin");
  clone = join(base, "clone");
  hookMarker = join(base, "hook-ran");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "one\n");
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "one");
  baseSha = sh(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "a.txt"), "two\n");
  sh(origin, "commit", "-q", "-am", "two");
  headSha = sh(origin, "rev-parse", "HEAD");

  // A commit only reachable through refs/pull/7/head, as GitHub exposes PRs from forks.
  sh(origin, "checkout", "-q", "-b", "pr");
  writeFileSync(join(origin, "a.txt"), "pr\n");
  sh(origin, "commit", "-q", "-am", "pr");
  prOnlySha = sh(origin, "rev-parse", "HEAD");
  // The pull ref tip is a child of prOnlySha, so prOnlySha itself is never advertised.
  writeFileSync(join(origin, "a.txt"), "pr2\n");
  sh(origin, "commit", "-q", "-am", "pr2");
  sh(origin, "update-ref", "refs/pull/7/head", sh(origin, "rev-parse", "HEAD"));
  sh(origin, "checkout", "-q", "main");
  sh(origin, "branch", "-q", "-D", "pr");

  // The local clone predates "two" so acquiring headSha must fetch it.
  execFileSync("git", ["clone", "-q", "--no-local", origin, clone]);
  sh(clone, "reset", "-q", "--hard", baseSha);
  sh(clone, "update-ref", "refs/remotes/origin/main", baseSha);
  sh(clone, "reflog", "expire", "--expire=now", "--all");
  sh(clone, "gc", "-q", "--prune=now");

  // A hook that would prove repo hooks run on checkout.
  for (const repo of [clone, origin]) {
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${hookMarker}"\n`);
    chmodSync(hook, 0o755);
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("git helper", () => {
  it("runs git without a shell and reports exit codes", async () => {
    const ok = await git(["rev-parse", "HEAD"], { cwd: origin });
    expect(ok).toMatchObject({ code: 0, stdout: `${headSha}\n` });
    const bad = await git(["rev-parse", "--verify", "nope; echo pwned"], { cwd: origin });
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).not.toContain("pwned");
    const missing = await git(["status"], { cwd: join(base, "does-not-exist") });
    expect(missing.code).toBe(-1);
  });
});

describe("scrubSecrets", () => {
  it("removes tokens, their base64 header forms and URL credentials", () => {
    const token = "ghs_abcdef123456";
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    const text = `fatal: ${token} header basic ${b64} https://user:pw@github.com/x.git raw ${Buffer.from(token).toString("base64")}`;
    const out = scrubSecrets(text, [token, undefined, ""]);
    expect(out).not.toContain(token);
    expect(out).not.toContain(b64);
    expect(out).not.toContain("user:pw");
    expect(out).toContain("https://***@github.com/x.git");
  });
});

describe("localWorkspace (repoPath)", () => {
  it("acquires a detached checkout of headSha, fetching it when missing", async () => {
    expect(() => sh(clone, "cat-file", "-e", `${headSha}^{commit}`)).toThrow();
    const ws = localWorkspace({ repoPath: clone, worktreeRoot: join(base, "wt") });
    const h = await ws.acquire(change(), { seatId: "hunter-1" });
    try {
      expect(h.headSha).toBe(headSha);
      expect(h.baseSha).toBe(baseSha);
      expect(h.cwd).toContain("hunter-1");
      expect(readFileSync(join(h.cwd, "a.txt"), "utf8")).toBe("two\n");
      expect(sh(h.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(sh(h.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // detached
      // The user's checkout is untouched.
      expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe("one\n");
      expect(existsSync(hookMarker)).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it("isolates seats and dispose removes the worktree", async () => {
    const ws = localWorkspace({ repoPath: clone, worktreeRoot: join(base, "wt") });
    const [a, b] = await Promise.all([ws.acquire(change(), { seatId: "a" }), ws.acquire(change(), { seatId: "b" })]);
    expect(a.cwd).not.toBe(b.cwd);
    writeFileSync(join(a.cwd, "a.txt"), "scribbled\n");
    expect(readFileSync(join(b.cwd, "a.txt"), "utf8")).toBe("two\n");
    await a.dispose();
    await a.dispose(); // idempotent
    expect(existsSync(a.cwd)).toBe(false);
    expect(sh(clone, "worktree", "list")).not.toContain(a.cwd);
    expect(sh(clone, "worktree", "list")).toContain(b.cwd);
    await b.dispose();
    expect(existsSync(b.cwd)).toBe(false);
    expect(sh(clone, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("falls back to the PR head ref when the sha cannot be fetched directly", async () => {
    // Protocol v0 refuses shas that are not advertised tips, forcing the refs/pull/<n>/head path.
    const ws = localWorkspace({
      repoPath: clone,
      worktreeRoot: join(base, "wt"),
      gitConfig: { "protocol.version": "0" },
    });
    const h = await ws.acquire(change({ headSha: prOnlySha }), { seatId: "pr" });
    expect(readFileSync(join(h.cwd, "a.txt"), "utf8")).toBe("pr\n");
    expect(sh(clone, "rev-parse", "--verify", "refs/merge-safely/pull/7^")).toBe(prOnlySha);
    await h.dispose();
  });

  it("ignores the caller's GIT_* environment (GIT_INDEX_FILE from a pre-commit hook must not be rewritten)", async () => {
    const saved = { ...process.env };
    const bogusIndex = join(base, "pre-commit-index");
    writeFileSync(bogusIndex, "user staged state");
    process.env.GIT_INDEX_FILE = bogusIndex;
    process.env.GIT_DIR = join(base, "nope.git");
    process.env.GIT_WORK_TREE = base;
    try {
      const ws = localWorkspace({ repoPath: clone, worktreeRoot: join(base, "wt") });
      const h = await ws.acquire(change(), { seatId: "env" });
      expect(readFileSync(join(h.cwd, "a.txt"), "utf8")).toBe("two\n");
      await h.dispose();
      expect(readFileSync(bogusIndex, "utf8")).toBe("user staged state");
    } finally {
      process.env = saved;
    }
  });

  it("dispose is idempotent under concurrency and retryable after a failure", async () => {
    const ws = localWorkspace({ repoPath: clone, worktreeRoot: join(base, "wt") });
    const h = await ws.acquire(change(), { seatId: "dispose" });
    // PR code made a directory unremovable.
    mkdirSync(join(h.cwd, "locked", "inner"), { recursive: true });
    writeFileSync(join(h.cwd, "locked", "inner", "f"), "x");
    chmodSync(join(h.cwd, "locked", "inner"), 0o500);
    chmodSync(join(h.cwd, "locked"), 0o500);
    const a = h.dispose();
    const b = h.dispose();
    await Promise.all([a, b]);
    expect(existsSync(h.cwd)).toBe(false);
    await h.dispose();
  });

  it("rejects a non-sha headSha", async () => {
    const ws = localWorkspace({ repoPath: clone, worktreeRoot: join(base, "wt") });
    await expect(ws.acquire(change({ headSha: "--upload-pack=evil" }))).rejects.toThrow(/full 40\/64-character/);
    await expect(ws.acquire(change({ headSha: headSha.slice(0, 12) }))).rejects.toThrow(/full 40\/64-character/);
  });
});

describe("localWorkspace (cloneUrl)", () => {
  it("keeps a bare mirror, fetches the sha and disables hooks", async () => {
    const cacheDir = join(base, "cache", "acme__demo.git");
    const ws = localWorkspace({ cloneUrl: origin, cacheDir, worktreeRoot: join(base, "wt2") });
    const h = await ws.acquire(change(), { seatId: "s1" });
    try {
      expect(existsSync(join(cacheDir, "HEAD"))).toBe(true);
      expect(sh(cacheDir, "rev-parse", "--is-bare-repository")).toBe("true");
      expect(readFileSync(join(h.cwd, "a.txt"), "utf8")).toBe("two\n");
      // Base is fetched too so git_diff works.
      expect(sh(h.cwd, "cat-file", "-t", baseSha)).toBe("commit");
      const hooksPath = sh(h.cwd, "config", "core.hooksPath");
      expect(readdirSync(hooksPath)).toEqual([]);
      // No remote (and so no URL or credential) is persisted in the mirror's config.
      expect(readFileSync(join(cacheDir, "config"), "utf8")).not.toContain(origin);
      expect(existsSync(hookMarker)).toBe(false);
    } finally {
      await h.dispose();
    }
    expect(existsSync(h.cwd)).toBe(false);

    // A second acquire reuses the mirror and can fetch a PR-only commit.
    const h2 = await ws.acquire(change({ headSha: prOnlySha }), { seatId: "s2" });
    expect(readFileSync(join(h2.cwd, "a.txt"), "utf8")).toBe("pr\n");
    await h2.dispose();
  });

  it("never leaks the token in errors", async () => {
    const token = "ghs_SuperSecretToken123";
    const ws = localWorkspace({
      cloneUrl: join(base, `missing-${token}`, "repo.git"),
      token,
      cacheDir: join(base, "cache", "missing.git"),
      worktreeRoot: join(base, "wt3"),
    });
    let message = "";
    try {
      await ws.acquire(change());
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not available|failed/);
    expect(message).not.toContain(token);
    expect(message).toContain("***");
    // The failed checkout directory is cleaned up.
    expect(existsSync(join(base, "wt3")) ? readdirSync(join(base, "wt3")) : []).toEqual([]);
  });

  it("does not write the token to the mirror's config", async () => {
    const token = "ghs_AnotherSecret456";
    const cacheDir = join(base, "cache", "tok.git");
    const ws = localWorkspace({ cloneUrl: origin, token, cacheDir, worktreeRoot: join(base, "wt4") });
    const h = await ws.acquire(change(), { seatId: "x" });
    await h.dispose();
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    const config = readFileSync(join(cacheDir, "config"), "utf8");
    expect(config).not.toContain(token);
    expect(config).not.toContain(b64);
  });

  it("rebuilds a mirror whose config was tampered with (e.g. a smudge filter planted by PR code)", async () => {
    const cacheDir = join(base, "cache", "tamper.git");
    const ws = localWorkspace({ cloneUrl: origin, cacheDir, worktreeRoot: join(base, "wt5") });
    const h = await ws.acquire(change(), { seatId: "t1" });
    await h.dispose();
    const marker = join(base, "smudge-ran");
    sh(cacheDir, "config", "filter.evil.smudge", `sh -c 'echo ran > ${marker}; cat'`);
    writeFileSync(join(cacheDir, "info", "attributes"), "* filter=evil\n");
    const h2 = await ws.acquire(change(), { seatId: "t2" });
    expect(readFileSync(join(h2.cwd, "a.txt"), "utf8")).toBe("two\n");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cacheDir, "config"), "utf8")).not.toContain("evil");
    // While a seat is live, a tampered mirror is refused rather than deleted under it.
    sh(cacheDir, "config", "core.pager", "evil");
    await expect(ws.acquire(change(), { seatId: "t3" })).rejects.toThrow(/was modified/);
    await h2.dispose();
  });

  it("moves URL userinfo into a scoped header instead of argv", () => {
    expect(splitUrlCredentials("https://bob:s3cr%40t@git.example.com/a/b.git")).toEqual({
      url: "https://git.example.com/a/b.git",
      basic: Buffer.from("bob:s3cr@t").toString("base64"),
    });
    expect(splitUrlCredentials("/local/path")).toEqual({ url: "/local/path" });
    expect(splitUrlCredentials("https://git.example.com/x.git")).toEqual({ url: "https://git.example.com/x.git" });
  });

  it("never passes URL credentials in argv or error text", async () => {
    const ws = localWorkspace({
      cloneUrl: "https://bob:PlainPassw0rd@git.invalid/x.git",
      cacheDir: join(base, "cache", "userinfo.git"),
      // No network in tests: make the fetch fail fast after argv/config are built.
      gitConfig: { "protocol.https.allow": "never" },
      worktreeRoot: join(base, "wt6"),
    });
    let message = "";
    try {
      await ws.acquire(change());
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not available/);
    expect(message).not.toContain("PlainPassw0rd");
    expect(message).not.toContain(Buffer.from("bob:PlainPassw0rd").toString("base64"));
  });

  it("sends the token only to fetch commands, scoped to the clone URL, never in argv", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const binDir = join(base, "spy-bin");
    const log = join(base, "spy.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh\n{ printf 'ARGS:'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; env | grep '^GIT_CONFIG_' | sort; } >> "${log}"\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(binDir, "git"), 0o755);
    const token = "ghs_SpyToken0123456789";
    const header = Buffer.from(`x-access-token:${token}`).toString("base64");
    const saved = process.env.PATH;
    process.env.PATH = `${binDir}:${saved}`;
    try {
      // 1. https: the fetch carries a header scoped to exactly that URL.
      const remote = localWorkspace({
        cloneUrl: "https://git.invalid/acme/demo.git",
        token,
        cacheDir: join(base, "cache", "spy-https.git"),
        worktreeRoot: join(base, "wt7"),
        gitConfig: { "protocol.https.allow": "never" },
      });
      await expect(remote.acquire(change())).rejects.toThrow(/not available/);
      // 2. a successful acquire: worktree add / remove / prune get no credentials at all.
      const local = localWorkspace({
        cloneUrl: origin,
        token,
        cacheDir: join(base, "cache", "spy-local.git"),
        worktreeRoot: join(base, "wt7"),
      });
      const h = await local.acquire(change(), { seatId: "spy" });
      await h.dispose();
    } finally {
      process.env.PATH = saved;
    }
    const entries = readFileSync(log, "utf8").split("ARGS:").filter(Boolean);
    const fetches = entries.filter((e) => e.startsWith(" fetch"));
    const others = entries.filter((e) => !e.startsWith(" fetch"));
    expect(fetches.some((e) => e.includes("http.https://git.invalid/acme/demo.git.extraheader"))).toBe(true);
    expect(fetches.some((e) => e.includes(header))).toBe(true);
    expect(others.some((e) => e.startsWith(" worktree add"))).toBe(true);
    for (const e of others) expect(e).not.toContain("extraheader");
    for (const e of entries) expect(e.split("\n")[0]).not.toContain(token);
    for (const e of entries) expect(e.split("\n")[0]).not.toContain(header);
    for (const e of entries) expect(e).toContain("GIT_CONFIG_KEY_0=core.hooksPath");
  });

  it("requires a source", () => {
    expect(() => localWorkspace({})).toThrow(/repoPath or cloneUrl/);
  });
});

describe("currentTreeWorkspace", () => {
  it("returns HEAD for a clean tree and a no-op dispose", async () => {
    const ws = currentTreeWorkspace(origin);
    const h = await ws.acquire(change());
    expect(h.cwd).toBe(origin);
    expect(h.headSha).toBe(headSha);
    expect(h.dirty).toBeUndefined();
    await h.dispose();
    expect(existsSync(origin)).toBe(true);
  });

  it("marks a dirty tree as WORKTREE", async () => {
    writeFileSync(join(origin, "untracked.txt"), "x\n");
    try {
      const h = await currentTreeWorkspace(origin).acquire(change());
      expect(h.headSha).toBe(WORKTREE_SHA);
      expect(h.dirty).toBe(true);
    } finally {
      rmSync(join(origin, "untracked.txt"));
    }
  });

  it("treats a non-repo directory as a dirty worktree", async () => {
    const dir = mkdtempSync(join(base, "plain-"));
    const h = await currentTreeWorkspace(dir).acquire(change());
    expect(h).toMatchObject({ headSha: WORKTREE_SHA, dirty: true });
  });
});
