/**
 * Turn an eval case into the `Change` and unified diff the gate reviews.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, ChangedFile, ChangeRef, Principal, UntrustedText } from "@merge-safely/core";
import { githubSource, type OctokitLike } from "@merge-safely/github";
import { confinedPath, FixtureError, materializeTrees, parseUnifiedDiff } from "./diff.js";
import type { LoadedCase } from "./suite.js";

/** A git repository holding the case's base and head commits, alive until the case finishes. */
export interface CaseRepo {
  repoPath: string;
  headSha: string;
  baseSha: string;
}

export interface MaterializedCase {
  change: Change;
  diff: string;
  untrusted: UntrustedText;
  /** Fixture cases only: the throwaway repository reviewers can check out. Diff and github cases have none. */
  repo?: CaseRepo;
  /** Release anything the case holds (the fixture repository). Idempotent. */
  dispose(): Promise<void>;
}

export interface MaterializeOptions {
  github?: { octokit: OctokitLike };
}

export class GithubTokenRequiredError extends Error {
  constructor(caseId: string) {
    super(`case ${caseId}: github source requires a GitHub token (token required); pass github.octokit`);
    this.name = "GithubTokenRequiredError";
  }
}

const EVAL_REPO = { host: "evals.local", owner: "evals", name: "suite" };

/** A deterministic fake SHA for diff cases that carry no commit (40 hex chars derived from the case id). */
export function syntheticSha(seed: string): string {
  let h1 = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h1.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

function stats(files: ChangedFile[]): Change["stats"] {
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files: files.length,
  };
}

function buildChange(lc: LoadedCase, files: ChangedFile[], baseSha: string, headSha: string, index: number): Change {
  const c = lc.spec.change;
  const author: Principal = { kind: c?.authorKind ?? "human", login: c?.author ?? "eval-author" };
  return {
    repo: EVAL_REPO,
    number: index + 1,
    headSha,
    baseSha,
    baseRef: c?.baseRef ?? "main",
    headRef: c?.headRef ?? `evals/${lc.spec.id}`,
    title: c?.title ?? lc.spec.title,
    body: c?.body ?? "",
    author,
    files,
    stats: stats(files),
    labels: c?.labels ?? [],
    draft: false,
    ciStatus: "success",
  };
}

/** Patches for explicitly listed files are filled from the diff when it has them. */
function mergeListedFiles(listed: ChangedFile[], parsed: ChangedFile[]): ChangedFile[] {
  return listed.map((f) => {
    const p = parsed.find((x) => x.path === f.path);
    return p?.patch !== undefined && f.patch === undefined ? { ...f, patch: p.patch } : f;
  });
}

export async function materializeCase(
  lc: LoadedCase,
  index: number,
  opts: MaterializeOptions = {},
): Promise<MaterializedCase> {
  const src = lc.spec.source;
  const noop = async () => {};
  if (src.type === "fixture") {
    const d = await materializeTrees(join(lc.dir, src.base), join(lc.dir, src.head), { confine: lc.dir });
    if (d.files.length === 0) {
      await d.dispose();
      throw new FixtureError(`case ${lc.spec.id}: base/ and head/ are identical; the fixture has no change to review`);
    }
    const change = buildChange(lc, d.files, d.baseSha, d.headSha, index);
    return {
      change,
      diff: d.diff,
      untrusted: { title: change.title, body: change.body },
      repo: { repoPath: d.repoPath, headSha: d.headSha, baseSha: d.baseSha },
      dispose: d.dispose,
    };
  }
  if (src.type === "diff") {
    const diffPath = await confinedPath(join(lc.dir, src.diff), lc.dir, `source.diff ${src.diff}`);
    if (!diffPath) throw new FixtureError(`case ${lc.spec.id}: source.diff ${src.diff} not found`);
    const diff = await readFile(diffPath, "utf8");
    const parsed = parseUnifiedDiff(diff);
    const files = src.files ? mergeListedFiles(src.files, parsed) : parsed;
    const change = buildChange(
      lc,
      files,
      syntheticSha(`${lc.spec.id}:base`),
      syntheticSha(`${lc.spec.id}:head`),
      index,
    );
    if (files.length === 0) throw new FixtureError(`case ${lc.spec.id}: source.diff ${src.diff} has no file changes`);
    return { change, diff, untrusted: { title: change.title, body: change.body }, dispose: noop };
  }
  if (!opts.github) throw new GithubTokenRequiredError(lc.spec.id);
  const [owner, name] = src.repo.split("/") as [string, string];
  const ref: ChangeRef = { repo: { host: "github.com", owner, name }, number: src.pr };
  const source = githubSource({ octokit: opts.github.octokit });
  const fetched = await source.getChange(ref);
  const headSha = src.headSha ?? fetched.headSha;
  const diff = await source.getDiff(ref, { headSha });
  // The PR may have moved since the incident: the file list then describes the wrong head, so derive it from the
  // pinned diff instead.
  const pinnedElsewhere = !fetched.headSha.startsWith(headSha) && !headSha.startsWith(fetched.headSha);
  const files = pinnedElsewhere ? parseUnifiedDiff(diff) : fetched.files;
  const change: Change = {
    ...fetched,
    headSha,
    files,
    stats: pinnedElsewhere ? stats(files) : fetched.stats,
    ...(lc.spec.change ? { title: lc.spec.change.title, body: lc.spec.change.body } : {}),
  };
  const ctx = await contextUpToHead(opts.github.octokit, ref, headSha, src.includeComments);
  return {
    change,
    diff,
    untrusted: { title: change.title, body: change.body, commitMessages: ctx.commitMessages, comments: ctx.comments },
    dispose: noop,
  };
}

const MAX_PAGES = 10;

async function allPages<T>(fetch: (page: number) => Promise<{ data: T[] }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await fetch(page);
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

function field(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const asTime = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

const ITEM_CHARS = 4000;
const clip = (s: string): string => (s.length > ITEM_CHARS ? `${s.slice(0, ITEM_CHARS)}…` : s);

/**
 * Untrusted context as it stood at the incident: commit messages of the PR's commits up to and including
 * `headSha` (none if headSha is not among them), and, only when `includeComments`, comments created no later than
 * the head commit's committer date (none when that date is unknown). Post-incident discussion never leaks in.
 */
export async function contextUpToHead(
  octokit: OctokitLike,
  ref: ChangeRef,
  headSha: string,
  includeComments: boolean,
): Promise<{ commitMessages: string[]; comments: string[] }> {
  const repo = { owner: ref.repo.owner, repo: ref.repo.name };
  const commits = await allPages((page) =>
    octokit.pulls.listCommits({ ...repo, pull_number: ref.number, per_page: 100, page }),
  );
  const idx = commits.findIndex((c) => c.sha.toLowerCase() === headSha.toLowerCase());
  const upTo = idx >= 0 ? commits.slice(0, idx + 1) : [];
  const commitMessages = upTo.slice(-50).map((c) => clip(c.commit.message));
  if (!includeComments) return { commitMessages, comments: [] };
  const head = upTo[upTo.length - 1];
  const cutoff = asTime(field(head, "commit", "committer", "date")) ?? asTime(field(head, "commit", "author", "date"));
  if (cutoff === undefined) return { commitMessages, comments: [] };
  const [issueComments, reviewComments] = await Promise.all([
    allPages((page) => octokit.issues.listComments({ ...repo, issue_number: ref.number, per_page: 100, page })),
    allPages((page) => octokit.pulls.listReviewComments({ ...repo, pull_number: ref.number, per_page: 100, page })),
  ]);
  const before = (c: unknown) => {
    const t = asTime(field(c, "created_at"));
    return t !== undefined && t <= cutoff;
  };
  const comments = [
    ...issueComments
      .filter((c) => before(c) && c.body)
      .map((c) => clip(`@${c.user?.login ?? "ghost"}: ${c.body ?? ""}`)),
    ...reviewComments.filter(before).map((c) => clip(`@${c.user?.login ?? "ghost"} on ${c.path}: ${c.body}`)),
  ].filter((c) => !c.includes("<!-- merge-safely"));
  return { commitMessages, comments: comments.slice(-50) };
}
