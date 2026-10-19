/**
 * A `Change` built from the local working tree for `run --local` / `estimate --local`.
 *
 * The diff is merge-base(base, HEAD) against the working tree, so it covers committed, staged and unstaged
 * changes in one coherent patch, plus untracked (not ignored) files as additions. Nothing is stored and nothing
 * leaves the machine except what the configured model connections receive.
 */
import { basename } from "node:path";
import type { Change, ChangedFile, FileStatus, RepoRef, UntrustedText } from "@merge-safely/core";
import { WORKTREE_SHA } from "@merge-safely/workspace-local";
import { CliError } from "./errors.js";
import type { Exec } from "./exec.js";

/** Pinned on every call so repository config cannot run code (fsmonitor, external diff, pager). */
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "diff.external=", "--no-pager"];
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];
/** Cap on the diff sent to reviewers. Files beyond it are listed in `omitted` and force tier 3. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface LocalChange {
  change: Change;
  diff: string;
  untrusted: UntrustedText;
  root: string;
  dirty: boolean;
  /** Changed files left out of the diff and file list because the diff hit the size cap. */
  omitted: string[];
}

export interface LocalChangeOptions {
  exec: Exec;
  cwd: string;
  /** Base ref; default from `defaultBaseRef`. */
  base?: string;
  /** Environment for the author fallback (USER). */
  env?: NodeJS.ProcessEnv;
  /** Diff size cap in bytes; default MAX_DIFF_BYTES. */
  maxDiffBytes?: number;
}

async function git(exec: Exec, cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  const r = await exec("git", [...GIT_SAFE, ...args], { cwd, timeoutMs: 120_000 });
  if (r.code === -1 && r.stderr === "" && r.stdout === "") {
    throw new CliError("GIT_UNAVAILABLE", "git is not installed or could not be started");
  }
  if (!okCodes.includes(r.code)) {
    const why = r.stderr.trim().split("\n")[0] ?? "";
    throw new CliError("GIT_ERROR", `git ${args[0] ?? ""} failed${why ? `: ${why}` : ""}`);
  }
  return r.stdout;
}

async function tryGit(exec: Exec, cwd: string, args: string[]): Promise<string | undefined> {
  const r = await exec("git", [...GIT_SAFE, ...args], { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout : undefined;
}

/** The repo's default branch (`origin/HEAD` → e.g. `origin/main`), else `main`. */
export async function defaultBaseRef(exec: Exec, cwd: string): Promise<string> {
  const out = await tryGit(exec, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const ref = out?.trim();
  return ref ? ref : "main";
}

/** `owner/name` from a GitHub remote URL (https, ssh or scp form), else undefined. */
export function repoFromRemote(url: string): RepoRef | undefined {
  const m = url
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  return { host: m[1], owner: m[2], name: m[3] };
}

const STATUS: Record<string, FileStatus> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "changed",
};

interface NameStatus {
  status: FileStatus;
  path: string;
  previousPath?: string;
}

/** Parse `git diff --name-status -z`. */
export function parseNameStatus(out: string): NameStatus[] {
  const parts = out.split("\0");
  const res: NameStatus[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? "";
    if (code === "") continue;
    const letter = code[0] ?? "M";
    const status = STATUS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      const from = parts[i++] ?? "";
      const to = parts[i++] ?? "";
      res.push({ status, path: to, previousPath: from });
    } else {
      res.push({ status, path: parts[i++] ?? "" });
    }
  }
  return res.filter((r) => r.path !== "");
}

/** Parse `git diff --numstat -z` into path → counts (binary files count as 0/0). */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++] ?? "";
    if (head === "") continue;
    const [a = "0", d = "0", path = ""] = head.split("\t");
    let p = path;
    if (p === "") {
      i++; // previous path of a rename
      p = parts[i++] ?? "";
    }
    const n = (s: string) => (s === "-" ? 0 : Number.parseInt(s, 10) || 0);
    map.set(p, { additions: n(a), deletions: n(d) });
  }
  return map;
}

/** Split a unified diff into per-file patches keyed by the new path (old path for deletions). */
export function splitPatches(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const plus = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const renameTo = chunk.match(/^rename to (.+)$/m)?.[1];
    const minus = chunk.match(/^--- a\/(.+)$/m)?.[1];
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = plus ?? renameTo ?? minus ?? header?.[2];
    if (path) map.set(path.trimEnd(), chunk);
  }
  return map;
}

export async function buildLocalChange(opts: LocalChangeOptions): Promise<LocalChange> {
  const { exec } = opts;
  const top = await tryGit(exec, opts.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new CliError("NOT_A_GIT_REPO", `${opts.cwd} is not inside a git repository`);
  const root = top.trim();
  const base = opts.base ?? (await defaultBaseRef(exec, root));
  const headSha = (await tryGit(exec, root, ["rev-parse", "--verify", "HEAD"]))?.trim();
  if (!headSha) throw new CliError("GIT_ERROR", "the repository has no commits yet");
  const baseSha = (await tryGit(exec, root, ["rev-parse", "--verify", `${base}^{commit}`]))?.trim();
  if (!baseSha) throw new CliError("BASE_NOT_FOUND", `base ref "${base}" not found; pass --base <ref>`);
  const mergeBase = (await tryGit(exec, root, ["merge-base", baseSha, headSha]))?.trim() || baseSha;

  const tracked = await git(exec, root, ["diff", ...DIFF_FLAGS, mergeBase, "--"]);
  const nameStatus = parseNameStatus(await git(exec, root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", mergeBase]));
  const numstat = parseNumstat(await git(exec, root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", mergeBase]));

  const untrackedList = (await git(exec, root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p !== "");
  const patches = splitPatches(tracked);

  interface Candidate {
    file: ChangedFile;
    patch: string;
  }
  const candidates: Candidate[] = nameStatus.map((ns) => {
    const counts = numstat.get(ns.path) ?? { additions: 0, deletions: 0 };
    return {
      file: {
        path: ns.path,
        status: ns.status,
        additions: counts.additions,
        deletions: counts.deletions,
        ...(ns.previousPath ? { previousPath: ns.previousPath } : {}),
      },
      patch: patches.get(ns.path) ?? "",
    };
  });
  for (const p of untrackedList) {
    if (candidates.some((c) => c.file.path === p)) continue;
    // Exit code 1 means "differences found", which is the point.
    const patch = await git(exec, root, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", p], [0, 1]);
    const additions = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    candidates.push({ file: { path: p, status: "added", additions, deletions: 0 }, patch });
  }

  // Every changed file is counted; files whose patch would push the diff past the cap are left out of the file list
  // and the diff (never silently: `omitted` lists them, and stats.files > files.length makes the core fail closed to
  // tier 3 with no triage auto-pass).
  const maxBytes = opts.maxDiffBytes ?? MAX_DIFF_BYTES;
  const files: ChangedFile[] = [];
  const omitted: string[] = [];
  let diff = "";
  for (const c of candidates) {
    if (diff.length + c.patch.length > maxBytes) {
      omitted.push(c.file.path);
      continue;
    }
    diff += c.patch;
    files.push(c.patch ? { ...c.file, patch: c.patch } : c.file);
  }
  const allFiles = candidates.map((c) => c.file);

  const status = await git(exec, root, ["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = status.trim() !== "";
  const branch = (await tryGit(exec, root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "HEAD";
  const userName = (await tryGit(exec, root, ["config", "user.name"]))?.trim();
  const userEmail = (await tryGit(exec, root, ["config", "user.email"]))?.trim();
  const lastMessage = ((await tryGit(exec, root, ["log", "-1", "--format=%B"])) ?? "").trim();
  const remote = (await tryGit(exec, root, ["remote", "get-url", "origin"]))?.trim();
  const repo = (remote && repoFromRemote(remote)) || { host: "local", owner: "local", name: basename(root) };

  const [subject = "", ...rest] = lastMessage.split("\n");
  const additions = allFiles.reduce((s, f) => s + f.additions, 0);
  const deletions = allFiles.reduce((s, f) => s + f.deletions, 0);
  const change: Change = {
    repo,
    number: 0,
    headSha: dirty ? WORKTREE_SHA : headSha,
    baseSha: mergeBase,
    baseRef: base,
    headRef: branch,
    title: subject || `Local changes on ${branch}`,
    body: rest.join("\n").trim(),
    author: {
      kind: "human",
      login: userName || opts.env?.USER || opts.env?.USERNAME || "local",
      ...(userEmail ? { id: userEmail } : {}),
    },
    files,
    stats: { additions, deletions, files: allFiles.length },
    labels: [],
    draft: false,
    ciStatus: "unknown",
  };
  const untrusted: UntrustedText = {
    title: change.title,
    body: change.body,
    commitMessages: lastMessage ? [lastMessage] : [],
  };
  return { change, diff, untrusted, root, dirty, omitted };
}
