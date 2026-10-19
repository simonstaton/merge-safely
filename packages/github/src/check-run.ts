import type { Change, Finding, ReportEvent, Reporter, Verdict } from "@merge-safely/core";
import { conclusionForVerdict, findCheckRun } from "./check-run-shared.js";
import { serializeVerdict as defaultSerialize } from "./check-run-store.js";
import type { CheckAnnotation, CheckConclusion, CheckRunData, OctokitLike } from "./octokit.js";
import { clip, DEFAULT_CHECK_NAME, GITHUB_TEXT_LIMIT, redactSecrets, truncateMarkdown } from "./util.js";

export interface CheckRunReporterOptions {
  octokit: OctokitLike;
  /** Defaults to `merge-safely/verdict`. Keep the `merge-safely/` prefix so the source provider ignores it. */
  checkName?: string;
  /** Link shown as "Details" on the check (also required context for `action_required`). Defaults to the PR URL. */
  detailsUrl?: string;
  /** Override how the verdict is stored in `output.text`. Defaults to the check-run store's serialiser. */
  serializeVerdict?: (v: Verdict) => string;
  now?: () => Date;
}

/** GitHub accepts at most 50 annotations per create/update request. */
export const ANNOTATIONS_PER_REQUEST = 50;
/** Hard cap on annotations per check run so a noisy round cannot fan out into hundreds of requests. */
export const MAX_ANNOTATIONS = 500;

const LEVEL: Record<Finding["severity"], CheckAnnotation["annotation_level"]> = {
  blocker: "failure",
  important: "warning",
  nit: "notice",
  "pre-existing": "notice",
};

/** Findings with a file and a positive line become annotations; others stay in the summary only. */
export function findingsToAnnotations(findings: Finding[]): CheckAnnotation[] {
  const out: CheckAnnotation[] = [];
  for (const f of findings) {
    if (!f.file || !f.line || f.line < 1) continue;
    const end = f.endLine && f.endLine >= f.line ? f.endLine : f.line;
    const fix = f.suggestedFix ? `\n\nSuggested: ${f.suggestedFix}` : "";
    out.push({
      path: f.file,
      start_line: f.line,
      end_line: end,
      annotation_level: LEVEL[f.severity],
      title: clip(`[${f.severity}] ${f.title}`, 255),
      message: clip(`${f.detail}${fix}`, 4000),
    });
    if (out.length >= MAX_ANNOTATIONS) break;
  }
  return out;
}

export function checkRunReporter(opts: CheckRunReporterOptions): Reporter {
  const { octokit } = opts;
  const name = opts.checkName ?? DEFAULT_CHECK_NAME;
  const serialize = opts.serializeVerdict ?? defaultSerialize;
  const now = () => (opts.now ? opts.now() : new Date()).toISOString();
  const details = (change: Change, override?: string) => override ?? opts.detailsUrl ?? change.url;
  const summary = (md: string) => truncateMarkdown(md, GITHUB_TEXT_LIMIT);
  const textOrUndefined = (t: string | null | undefined) => (t ? truncateMarkdown(t, GITHUB_TEXT_LIMIT) : undefined);

  async function pending(change: Change, title: string, body: string): Promise<void> {
    const existing = await findCheckRun(octokit, change.repo, change.headSha, name);
    const detailsUrl = details(change);
    const output = { title, summary: summary(body), text: textOrUndefined(existing?.output.text) };
    if (existing) {
      await octokit.checks.update({
        owner: change.repo.owner,
        repo: change.repo.name,
        check_run_id: existing.id,
        status: "in_progress",
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        output,
      });
      return;
    }
    await octokit.checks.create({
      owner: change.repo.owner,
      repo: change.repo.name,
      name,
      head_sha: change.headSha,
      status: "in_progress",
      started_at: now(),
      ...(detailsUrl ? { details_url: detailsUrl } : {}),
      output,
    });
  }

  async function complete(
    change: Change,
    conclusion: CheckConclusion,
    title: string,
    body: string,
    text: string | undefined,
    annotations: CheckAnnotation[] = [],
    detailsOverride?: string,
  ): Promise<void> {
    const existing: CheckRunData | null = await findCheckRun(octokit, change.repo, change.headSha, name);
    const keptText = text ?? textOrUndefined(existing?.output.text);
    const base = { title: clip(title, 255), summary: summary(body), ...(keptText ? { text: keptText } : {}) };
    const first = annotations.slice(0, ANNOTATIONS_PER_REQUEST);
    const detailsUrl = details(change, detailsOverride);
    const common = {
      owner: change.repo.owner,
      repo: change.repo.name,
      conclusion,
      completed_at: now(),
      ...(detailsUrl ? { details_url: detailsUrl } : {}),
      output: { ...base, ...(first.length ? { annotations: first } : {}) },
    };
    const id = existing
      ? (await octokit.checks.update({ ...common, check_run_id: existing.id })).data.id
      : (await octokit.checks.create({ ...common, name, head_sha: change.headSha })).data.id;
    for (let i = ANNOTATIONS_PER_REQUEST; i < annotations.length; i += ANNOTATIONS_PER_REQUEST) {
      await octokit.checks.update({
        owner: change.repo.owner,
        repo: change.repo.name,
        check_run_id: id,
        output: { ...base, annotations: annotations.slice(i, i + ANNOTATIONS_PER_REQUEST) },
      });
    }
  }

  return {
    async report(event: ReportEvent): Promise<void> {
      switch (event.type) {
        case "pending": {
          const tier = event.tier ? ` (tier ${event.tier.level})` : "";
          const body =
            event.message ??
            `Merge Safely is reviewing \`${event.change.headSha.slice(0, 12)}\` (round ${event.round}).`;
          await pending(event.change, `Review in progress${tier}`, body);
          return;
        }
        case "verdict":
          await complete(
            event.change,
            conclusionForVerdict(event.verdict),
            event.digest.headline,
            event.digest.markdown,
            serialize(event.verdict),
            findingsToAnnotations(event.verdict.findings),
          );
          return;
        case "escalated": {
          const link = event.handle.url ? `[${event.handle.id}](${event.handle.url})` : `\`${event.handle.id}\``;
          await complete(
            event.change,
            "action_required",
            event.digest.headline,
            `**Escalated for human review:** ${link}\n\n${event.digest.markdown}`,
            serialize(event.verdict),
            findingsToAnnotations(event.verdict.findings),
            event.handle.url,
          );
          return;
        }
        case "budget-blocked":
          await complete(event.change, "failure", event.digest.headline, event.digest.markdown, undefined);
          return;
        case "error":
          await complete(
            event.change,
            "failure",
            "Review failed",
            `Merge Safely could not complete round ${event.round}. The change is blocked until a review succeeds.\n\n\`\`\`\n${clip(redactSecrets(event.error), 2000)}\n\`\`\``,
            undefined,
          );
          return;
      }
    },
  };
}
