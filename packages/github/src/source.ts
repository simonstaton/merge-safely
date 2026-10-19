import type {
  Change,
  ChangedFile,
  ChangeRef,
  CiStatus,
  FileStatus,
  Principal,
  RepoRef,
  SourceProvider,
  TicketRef,
} from "@merge-safely/core";
import { type CheckRunData, collectPages, errorStatus, type OctokitLike, type PullFileData } from "./octokit.js";
import { CHECK_NAME_PREFIX, clip } from "./util.js";

export interface GithubSourceOptions {
  octokit: OctokitLike;
  /** Check runs and commit statuses whose name starts with this prefix are ignored for ciStatus. */
  ownCheckPrefix?: string;
}

/** GitHub's compare endpoint refuses diffs above these (406 "diff too large" or a 300-file cap). */
export const DIFF_FILE_LIMIT = 300;
export const DIFF_LINE_LIMIT = 20_000;
/** Max files we page through for a PR (GitHub's own listFiles hard cap is 3000). */
const MAX_FILES = 3000;

export const UNTRUSTED_ITEM_CAP = 50;
export const UNTRUSTED_ITEM_CHARS = 4000;

const FILE_STATUSES: readonly FileStatus[] = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
];

/** Labels that mark a change as AI/agent-authored. */
export const AGENT_LABELS = ["ai-authored", "agent"] as const;
/** Co-author names that mark an AI-assisted change. Kept short and obvious on purpose. */
const AI_COAUTHOR = /\b(claude|anthropic|copilot|openai|chatgpt|gpt-?\d|codex|gemini|cursor|devin|aider|windsurf)\b/i;

const asStatus = (s: string): FileStatus =>
  (FILE_STATUSES as readonly string[]).includes(s) ? (s as FileStatus) : "changed";

/**
 * Classify the PR author.
 * - `bot`: GitHub says `type: "Bot"` or the login ends with `[bot]` (Apps, Dependabot, Renovate).
 * - `agent`: a human account, but the PR carries an `ai-authored`/`agent` label, or the body has a
 *   `Co-Authored-By:` trailer naming a well-known AI assistant. This is a cheap heuristic, not proof.
 * - `human` otherwise.
 */
export function classifyAuthor(
  user: { login: string; id?: number; type?: string } | null,
  labels: string[],
  body: string,
): Principal {
  const login = user?.login ?? "ghost";
  const id = user?.id;
  if (user?.type === "Bot" || login.toLowerCase().endsWith("[bot]")) return { kind: "bot", login, id };
  const lowered = labels.map((l) => l.toLowerCase());
  const agentLabel = AGENT_LABELS.some((l) => lowered.includes(l));
  const coAuthors = [...body.matchAll(/^\s*co-authored-by:\s*(.+)$/gim)].map((m) => m[1] ?? "");
  if (agentLabel || coAuthors.some((c) => AI_COAUTHOR.test(c))) return { kind: "agent", login, id };
  return { kind: "human", login, id };
}

/**
 * Find the linked ticket in a PR body. First match wins in this order:
 * 1. GitHub closing keywords: `Fixes #12`, `Closes org/repo#12`, `Resolves #3` → `github-issue`, id `owner/repo#n`.
 * 2. Linear URLs (`linear.app/<ws>/issue/ABC-123`) → `linear`, id `ABC-123`.
 * 3. Jira URLs (`<x>.atlassian.net/browse/ABC-123`, or any `/browse/KEY-123`) → `jira`, id `ABC-123`.
 */
export function parseLinkedTicket(body: string, repo: RepoRef): TicketRef | undefined {
  const gh = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/i.exec(body);
  if (gh) {
    const owner = gh[1] ?? repo.owner;
    const name = gh[2] ?? repo.name;
    const n = gh[3] ?? "";
    return {
      provider: "github-issue",
      id: `${owner}/${name}#${n}`,
      url: `https://${repo.host}/${owner}/${name}/issues/${n}`,
    };
  }
  const linear = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)[^\s)>\]]*/i.exec(body);
  if (linear?.[1]) return { provider: "linear", id: linear[1].toUpperCase(), url: linear[0] };
  const jira = /https?:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9]+-\d+)\b/.exec(body);
  if (jira?.[1]) return { provider: "jira", id: jira[1], url: jira[0] };
  return undefined;
}

/** Aggregate one CI state. Precedence: failure > pending > success; nothing at all is unknown. */
export function aggregateCi(states: ("pending" | "success" | "failure")[]): CiStatus {
  if (states.length === 0) return "unknown";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return "success";
}

export function checkRunState(run: Pick<CheckRunData, "status" | "conclusion">): "pending" | "success" | "failure" {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "success";
    case "stale":
    case null:
      return "pending";
    default:
      return "failure"; // failure, timed_out, cancelled, action_required, startup_failure
  }
}

function statusState(state: string): "pending" | "success" | "failure" {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure"; // failure, error
}

const repoParams = (repo: RepoRef) => ({ owner: repo.owner, repo: repo.name });

function fileHeader(f: PullFileData): string {
  const oldPath = f.previous_filename ?? f.filename;
  const a = f.status === "added" ? "/dev/null" : `a/${oldPath}`;
  const b = f.status === "removed" ? "/dev/null" : `b/${f.filename}`;
  return `diff --git a/${oldPath} b/${f.filename}\n--- ${a}\n+++ ${b}`;
}

/**
 * Concatenate per-file patches into a unified diff. Files without a patch (binary, or too large for
 * GitHub to inline) and files beyond what the API returned are counted as omitted and noted in a
 * trailer line so reviewers know the diff is partial.
 */
export function diffFromFiles(files: PullFileData[], totalFiles = files.length): string {
  const parts: string[] = [];
  let omitted = Math.max(0, totalFiles - files.length);
  for (const f of files) {
    if (!f.patch) {
      omitted++;
      continue;
    }
    parts.push(`${fileHeader(f)}\n${f.patch.endsWith("\n") ? f.patch.slice(0, -1) : f.patch}`);
  }
  let out = parts.join("\n");
  if (omitted > 0) out += `${out ? "\n" : ""}# merge-safely: diff truncated (${omitted} files omitted)`;
  return out.length > 0 ? `${out}\n` : out;
}

function isDiffTooLarge(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 406 || status === 422) return true;
  const msg = err instanceof Error ? err.message : "";
  return /too large|exceeded|maximum number/i.test(msg);
}

export function githubSource(opts: GithubSourceOptions): SourceProvider {
  const { octokit } = opts;
  const ownPrefix = opts.ownCheckPrefix ?? CHECK_NAME_PREFIX;

  const listFiles = (ref: ChangeRef) =>
    collectPages(
      async (page, per_page) =>
        (await octokit.pulls.listFiles({ ...repoParams(ref.repo), pull_number: ref.number, per_page, page })).data,
      { maxItems: MAX_FILES },
    );

  async function ciStatus(repo: RepoRef, sha: string): Promise<CiStatus> {
    const [statuses, runs] = await Promise.all([
      collectPages(
        async (page, per_page) =>
          (await octokit.repos.getCombinedStatusForRef({ ...repoParams(repo), ref: sha, per_page, page })).data
            .statuses,
        { maxItems: 500 },
      ),
      collectPages(
        async (page, per_page) =>
          (await octokit.checks.listForRef({ ...repoParams(repo), ref: sha, filter: "latest", per_page, page })).data
            .check_runs,
        { maxItems: 500 },
      ),
    ]);
    const states = [
      ...statuses.filter((s) => !s.context.startsWith(ownPrefix)).map((s) => statusState(s.state)),
      ...runs.filter((r) => !r.name.startsWith(ownPrefix)).map(checkRunState),
    ];
    return aggregateCi(states);
  }

  return {
    async getChange(ref: ChangeRef): Promise<Change> {
      const { data: pr } = await octokit.pulls.get({ ...repoParams(ref.repo), pull_number: ref.number });
      const [rawFiles, ci] = await Promise.all([listFiles(ref), ciStatus(ref.repo, pr.head.sha)]);
      const labels = pr.labels.map((l) => l.name);
      const body = pr.body ?? "";
      const files: ChangedFile[] = rawFiles.map((f) => ({
        path: f.filename,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        status: asStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch !== undefined ? { patch: f.patch } : {}),
      }));
      const linkedTicket = parseLinkedTicket(body, ref.repo);
      return {
        repo: ref.repo,
        number: ref.number,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        title: pr.title,
        body,
        author: classifyAuthor(pr.user, labels, body),
        files,
        stats: { additions: pr.additions, deletions: pr.deletions, files: pr.changed_files },
        labels,
        draft: pr.draft === true,
        ciStatus: ci,
        ...(linkedTicket ? { linkedTicket } : {}),
        // A deleted fork has head.repo === null: still a fork, never trusted as same-repo.
        fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
        url: pr.html_url,
      };
    },

    async getDiff(ref: ChangeRef, diffOpts?: { sinceSha?: string }): Promise<string> {
      const { data: pr } = await octokit.pulls.get({ ...repoParams(ref.repo), pull_number: ref.number });
      const since = diffOpts?.sinceSha;
      const basehead = since ? `${since}...${pr.head.sha}` : `${pr.base.sha}...${pr.head.sha}`;
      const tooBig = !since && (pr.changed_files > DIFF_FILE_LIMIT || pr.additions + pr.deletions > DIFF_LINE_LIMIT);
      if (!tooBig) {
        try {
          const res = await octokit.repos.compareCommitsWithBasehead({
            ...repoParams(ref.repo),
            basehead,
            mediaType: { format: "diff" },
          });
          const data: unknown = res.data;
          if (typeof data === "string") return data;
        } catch (err: unknown) {
          if (!isDiffTooLarge(err)) throw err;
        }
      }
      if (since) {
        // Delta fallback: the compare JSON carries per-file patches (GitHub caps it at 300 files).
        const { data } = await octokit.repos.compareCommitsWithBasehead({ ...repoParams(ref.repo), basehead });
        return diffFromFiles(data.files ?? []);
      }
      return diffFromFiles(await listFiles(ref), pr.changed_files);
    },

    async getUntrustedContext(ref: ChangeRef): Promise<{ commitMessages: string[]; comments: string[] }> {
      const base = { ...repoParams(ref.repo), pull_number: ref.number };
      const [commits, issueComments, reviewComments] = await Promise.all([
        collectPages(async (page, per_page) => (await octokit.pulls.listCommits({ ...base, per_page, page })).data, {
          maxItems: 250,
        }),
        collectPages(
          async (page, per_page) =>
            (await octokit.issues.listComments({ ...repoParams(ref.repo), issue_number: ref.number, per_page, page }))
              .data,
          { maxItems: 500 },
        ),
        collectPages(
          async (page, per_page) => (await octokit.pulls.listReviewComments({ ...base, per_page, page })).data,
          { maxItems: 500 },
        ),
      ]);
      // Our own digests are excluded: feeding the gate's output back as "context" only adds noise.
      const notOurs = (body: string) => !body.includes("<!-- merge-safely");
      const latest = <T>(xs: T[]) => xs.slice(-UNTRUSTED_ITEM_CAP);
      const commitMessages = latest(commits).map((c) => clip(c.commit.message, UNTRUSTED_ITEM_CHARS));
      const comments = [
        ...latest(issueComments.filter((c) => c.body && notOurs(c.body))).map((c) =>
          clip(`@${c.user?.login ?? "ghost"}: ${c.body ?? ""}`, UNTRUSTED_ITEM_CHARS),
        ),
        ...latest(reviewComments.filter((c) => notOurs(c.body))).map((c) =>
          clip(`@${c.user?.login ?? "ghost"} on ${c.path}: ${c.body}`, UNTRUSTED_ITEM_CHARS),
        ),
      ];
      return { commitMessages, comments };
    },
  };
}
