import {
  type Change,
  DEFAULT_POLICY,
  type Finding,
  type HumanDigest,
  type Policy,
  type ReportEvent,
  type Reporter,
  type Verdict,
} from "@merge-safely/core";
import { collectPages, errorStatus, type OctokitLike, type ReviewCommentParams } from "./octokit.js";
import { clip, GITHUB_TEXT_LIMIT, truncateMarkdown } from "./util.js";

export interface PrReviewReporterOptions {
  octokit: OctokitLike;
  /** Only `reporting` is read. Defaults to the core's default policy. */
  policy?: Pick<Policy, "reporting">;
  /** Tag used in the hidden HTML marker. Defaults to `merge-safely`. */
  marker?: string;
}

/** Cap on inline comments per review; the rest are still in the review body. */
export const MAX_INLINE_COMMENTS = 50;

/** Markers only count when a bot (the Action token or the App) wrote them, so a human cannot suppress the gate by pasting one. */
const byBot = (u: { login: string; type?: string } | null) =>
  u?.type === "Bot" || (u?.login.endsWith("[bot]") ?? false);

const safeTag = (tag: string) => tag.replace(/[^A-Za-z0-9_.:-]/g, "") || "merge-safely";

export function reviewMarker(tag: string, round: number, sha: string): string {
  return `<!-- ${safeTag(tag)} round=${round} sha=${sha} -->`;
}

export function commentMarker(tag: string, kind: "error" | "budget-blocked", sha: string, round?: number): string {
  return `<!-- ${safeTag(tag)} kind=${kind}${round === undefined ? "" : ` round=${round}`} sha=${sha} -->`;
}

/** RIGHT-side line numbers a review comment can attach to (added and context lines of every hunk). */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  let inHunk = false;
  for (const l of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      right = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || l.startsWith("\\")) continue;
    if (l.startsWith("-")) continue;
    if (l.startsWith("+") || l.startsWith(" ") || l === "") {
      lines.add(right);
      right++;
    }
  }
  return lines;
}

function inlineBody(f: Finding): string {
  const fix = f.suggestedFix ? `\n\n**Suggested:** ${f.suggestedFix}` : "";
  return clip(`**[${f.severity}] ${f.title}** \`${f.class}\`\n\n${f.detail}${fix}`, 4000);
}

export function prReviewReporter(opts: PrReviewReporterOptions): Reporter {
  const { octokit } = opts;
  const reporting = opts.policy?.reporting ?? DEFAULT_POLICY.reporting;
  const tag = opts.marker ?? "merge-safely";

  const prParams = (c: Change) => ({ owner: c.repo.owner, repo: c.repo.name, pull_number: c.number });

  async function hasReview(c: Change, marker: string): Promise<boolean> {
    const reviews = await collectPages(
      async (page, per_page) => (await octokit.pulls.listReviews({ ...prParams(c), per_page, page })).data,
      { maxItems: 1000 },
    );
    return reviews.some((r) => byBot(r.user) && r.body.includes(marker));
  }

  async function hasComment(c: Change, marker: string): Promise<boolean> {
    const comments = await collectPages(
      async (page, per_page) =>
        (
          await octokit.issues.listComments({
            owner: c.repo.owner,
            repo: c.repo.name,
            issue_number: c.number,
            per_page,
            page,
          })
        ).data,
      { maxItems: 1000 },
    );
    return comments.some((x) => byBot(x.user) && (x.body ?? "").includes(marker));
  }

  async function inlineComments(c: Change, findings: Finding[]): Promise<ReviewCommentParams[]> {
    if (!reporting.inlineComments) return [];
    const located = findings.filter((f) => f.file && f.line && f.line > 0);
    if (located.length === 0) return [];
    // Ask GitHub, not the Change: the comment must land on a line GitHub can resolve in this diff.
    const files = await collectPages(
      async (page, per_page) => (await octokit.pulls.listFiles({ ...prParams(c), per_page, page })).data,
      { maxItems: 3000 },
    );
    const byPath = new Map(files.map((f) => [f.filename, f.patch ? commentableLines(f.patch) : new Set<number>()]));
    const out: ReviewCommentParams[] = [];
    for (const f of located) {
      const lines = f.file ? byPath.get(f.file) : undefined;
      if (!f.file || !f.line || !lines?.has(f.line)) continue;
      out.push({ path: f.file, line: f.line, side: "RIGHT", body: inlineBody(f) });
      if (out.length >= MAX_INLINE_COMMENTS) break;
    }
    return out;
  }

  async function postVerdictReview(c: Change, v: Verdict, digest: HumanDigest, preface = ""): Promise<void> {
    const marker = reviewMarker(tag, v.round, v.headSha);
    if (await hasReview(c, marker)) return;
    // Never "APPROVE": a machine verdict is a signal for the merge gate (the check run), never a
    // human approval that could satisfy branch protection's required-reviewers rule.
    const event = v.decision === "block" && reporting.requestChangesOnBlock ? "REQUEST_CHANGES" : "COMMENT";
    const body = truncateMarkdown(`${marker}\n${preface}${digest.markdown}`, GITHUB_TEXT_LIMIT);
    const comments = await inlineComments(c, v.findings);
    const base = { ...prParams(c), commit_id: v.headSha, event } as const;
    try {
      await octokit.pulls.createReview({ ...base, body, ...(comments.length ? { comments } : {}) });
    } catch (err: unknown) {
      // 422 = a comment line GitHub could not resolve (e.g. the PR moved on). Keep the digest anyway.
      if (errorStatus(err) !== 422 || comments.length === 0) throw err;
      await octokit.pulls.createReview({ ...base, body });
    }
  }

  async function postComment(c: Change, marker: string, text: string): Promise<void> {
    if (await hasComment(c, marker)) return;
    await octokit.issues.createComment({
      owner: c.repo.owner,
      repo: c.repo.name,
      issue_number: c.number,
      body: truncateMarkdown(`${marker}\n${text}`, GITHUB_TEXT_LIMIT),
    });
  }

  return {
    async report(event: ReportEvent): Promise<void> {
      if (!reporting.postPrReview) return;
      switch (event.type) {
        case "pending":
          return;
        case "verdict":
          await postVerdictReview(event.change, event.verdict, event.digest);
          return;
        case "escalated": {
          const link = event.handle.url ? `[${event.handle.id}](${event.handle.url})` : `\`${event.handle.id}\``;
          await postVerdictReview(
            event.change,
            event.verdict,
            event.digest,
            `**Escalated for human review:** ${link}\n\n`,
          );
          return;
        }
        case "budget-blocked":
          await postComment(
            event.change,
            commentMarker(tag, "budget-blocked", event.change.headSha),
            `**Merge Safely: review blocked by budget** (${event.ceiling}).\n\n${event.digest.markdown}`,
          );
          return;
        case "error":
          // The error detail stays in the check run (redacted); PR comments are visible to everyone with read access.
          await postComment(
            event.change,
            commentMarker(tag, "error", event.change.headSha, event.round),
            `**Merge Safely could not complete the review (round ${event.round}).** The \`${reporting.checkName}\` check stays failing until a review succeeds; see the check run for details.`,
          );
          return;
      }
    },
  };
}
