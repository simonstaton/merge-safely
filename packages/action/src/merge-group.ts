/**
 * Merge queue support (`merge_group` event).
 *
 * The queue builds a new commit (the PR on top of the target branch and anything queued ahead of it) and waits for
 * the required checks on THAT SHA. The gate never reviewed it, and re-reviewing every queue commit would double the
 * model bill for no new information: the code each PR adds was already reviewed on the PR's head. So for each PR in
 * the group we look up the stored verdict on the PR's current head (the check-run store) and report the required
 * check on the queue commit: success when every PR has a machine or human `pass` on its current head, failure
 * otherwise, naming the PRs that lack one.
 */
import type { Logger, Policy, RepoRef, Verdict, VerdictStore } from "@merge-safely/core";
import { type OctokitLike, resolveCheckName } from "@merge-safely/github";

export interface MergeGroupPr {
  number: number;
  /** The PR's current head SHA. */
  headSha: string;
  /** Stored verdict on that head, if any. */
  atHead: Verdict | null;
  /** Newest stored verdict for the PR on any SHA, consulted only to explain a miss. */
  latest: Verdict | null;
}

export interface MergeGroupEntry {
  number: number;
  headSha: string;
  ok: boolean;
  /** One line: what was found (or what is missing). */
  detail: string;
  verdict?: Pick<Verdict, "headSha" | "decision" | "kind" | "round">;
}

export interface MergeGroupResult {
  ok: boolean;
  entries: MergeGroupEntry[];
  title: string;
  summary: string;
}

const short = (sha: string) => sha.slice(0, 7);

function isLivePass(v: Verdict, now: Date): boolean {
  if (v.decision !== "pass" || v.contested) return false;
  if (v.expiresAt && Date.parse(v.expiresAt) <= now.getTime()) return false;
  return true;
}

function entryFor(pr: MergeGroupPr, now: Date): MergeGroupEntry {
  const base = { number: pr.number, headSha: pr.headSha };
  const v = pr.atHead;
  if (v && v.headSha === pr.headSha && v.number === pr.number) {
    const pick = { headSha: v.headSha, decision: v.decision, kind: v.kind, round: v.round };
    const who = v.kind === "human" ? `human${v.signedBy ? ` (${v.signedBy.login})` : ""}` : "machine";
    if (isLivePass(v, now)) {
      return { ...base, ok: true, verdict: pick, detail: `${who} pass on ${short(v.headSha)}, round ${v.round}` };
    }
    const why = v.contested
      ? "contested (a pass conflicts with an unresolved block)"
      : v.decision === "pass"
        ? "expired"
        : v.decision;
    return { ...base, ok: false, verdict: pick, detail: `${who} verdict on ${short(v.headSha)} is ${why}` };
  }
  const l = pr.latest;
  if (l && l.headSha !== pr.headSha) {
    return {
      ...base,
      ok: false,
      detail: `no verdict on the current head ${short(pr.headSha)}; the latest (${l.decision}) is on ${short(l.headSha)}, an older commit`,
    };
  }
  return { ...base, ok: false, detail: `no verdict on the current head ${short(pr.headSha)}` };
}

/** Pure: decide the queue check from each PR's stored verdicts. */
export function evaluateMergeGroup(prs: MergeGroupPr[], now: Date = new Date()): MergeGroupResult {
  const entries = prs.map((p) => entryFor(p, now));
  const ok = entries.length > 0 && entries.every((e) => e.ok);
  const failing = entries.filter((e) => !e.ok);
  const title = ok
    ? `Merge queue: ${entries.length} PR${entries.length === 1 ? "" : "s"} passed review`
    : `Merge queue: ${failing.map((e) => `#${e.number}`).join(", ") || "no PR"} lack${failing.length === 1 ? "s" : ""} a pass`;
  const lines = entries.map((e) => `- ${e.ok ? "pass" : "**missing**"} #${e.number}: ${e.detail}`);
  const summary = [
    ok
      ? "Every PR in this merge group has a `pass` verdict on its current head. The queue commit itself is not re-reviewed."
      : "Not every PR in this merge group has a `pass` verdict on its current head. Re-run the review on the PR (push, or workflow_dispatch with pr-number), then re-queue.",
    "",
    ...(lines.length ? lines : ["- no PR found in this merge group"]),
  ].join("\n");
  return { ok, entries, title, summary };
}

export interface MergeGroupRunOptions {
  octokit: OctokitLike;
  store: VerdictStore;
  policy: Policy;
  repo: RepoRef;
  /** The merge-queue commit. */
  headSha: string;
  prNumbers: number[];
  logger: Logger;
  detailsUrl?: string;
  now?: () => Date;
}

async function latestVerdict(store: VerdictStore, repo: RepoRef, number: number): Promise<Verdict | null> {
  const all = await store.listForChange(repo, number);
  let best: Verdict | null = null;
  for (const v of all) if (!best || v.createdAt > best.createdAt) best = v;
  return best;
}

/** Look up each PR, evaluate, and write the required check on the queue commit. */
export async function runMergeGroup(o: MergeGroupRunOptions): Promise<MergeGroupResult & { checkRunId?: number }> {
  const prs: MergeGroupPr[] = [];
  for (const number of o.prNumbers) {
    const { data } = await o.octokit.pulls.get({ owner: o.repo.owner, repo: o.repo.name, pull_number: number });
    const headSha = data.head.sha;
    const found = await o.store.get({ repo: o.repo, number, headSha });
    const atHead = found?.verdict ?? null;
    const latest = atHead ? null : await latestVerdict(o.store, o.repo, number);
    prs.push({ number, headSha, atHead, latest });
  }
  const result = evaluateMergeGroup(prs, o.now?.() ?? new Date());
  const name = resolveCheckName(undefined, o.policy);
  const at = (o.now?.() ?? new Date()).toISOString();
  const { data } = await o.octokit.checks.create({
    owner: o.repo.owner,
    repo: o.repo.name,
    name,
    head_sha: o.headSha,
    status: "completed",
    conclusion: result.ok ? "success" : "failure",
    started_at: at,
    completed_at: at,
    ...(o.detailsUrl ? { details_url: o.detailsUrl } : {}),
    output: { title: result.title, summary: result.summary },
  });
  o.logger.info(`merge queue: ${name} ${result.ok ? "success" : "failure"} on ${o.headSha}`);
  return { ...result, checkRunId: data.id };
}
