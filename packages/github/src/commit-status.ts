import type { Change, Policy, ReportEvent, Reporter, Verdict } from "@merge-safely/core";
import { resolveCheckName } from "./identity.js";
import type { OctokitLike } from "./octokit.js";
import { clip } from "./util.js";

/**
 * Merge signal as a commit status, for tokens that cannot write check runs (PATs: the Checks API is
 * App-only). Statuses carry only a 140-char description, so there is no digest, no annotations and
 * no verdict storage: pair it with `prReviewReporter` and a local store (store-fs / store-sqlite).
 *
 * State mapping: pending -> pending; pass -> success; block, budget-blocked, error -> failure;
 * undecided, contested or escalated -> pending (still blocks a required status, awaiting a human).
 *
 * Weaker than the check run: anyone with `repo:status` can set the same context.
 */
export interface CommitStatusReporterOptions {
  octokit: OctokitLike;
  /** Status context. Defaults to `policy.reporting.checkName` (`merge-safely/verdict`). */
  context?: string;
  policy?: Pick<Policy, "reporting">;
  /** Target link. Defaults to the PR URL. */
  targetUrl?: string;
}

const DESCRIPTION_MAX = 140;

function stateFor(v: Pick<Verdict, "decision" | "contested">): "success" | "failure" | "pending" {
  if (v.decision === "block") return "failure";
  if (v.decision === "pending" || v.contested) return "pending";
  return "success";
}

export function commitStatusReporter(opts: CommitStatusReporterOptions): Reporter {
  const { octokit } = opts;
  const context = resolveCheckName(opts.context, opts.policy);

  async function set(c: Change, state: "success" | "failure" | "pending", description: string, url?: string) {
    const target = url ?? opts.targetUrl ?? c.url;
    await octokit.repos.createCommitStatus({
      owner: c.repo.owner,
      repo: c.repo.name,
      sha: c.headSha,
      state,
      context,
      description: clip(description, DESCRIPTION_MAX),
      ...(target ? { target_url: target } : {}),
    });
  }

  return {
    async report(event: ReportEvent): Promise<void> {
      switch (event.type) {
        case "pending":
          await set(
            event.change,
            "pending",
            `Review in progress${event.tier ? ` (tier ${event.tier.level})` : ""}, round ${event.round}`,
          );
          return;
        case "verdict":
          await set(event.change, stateFor(event.verdict), event.digest.headline);
          return;
        case "escalated":
          await set(event.change, "pending", `Escalated for human review: ${event.digest.headline}`, event.handle.url);
          return;
        case "budget-blocked":
          await set(event.change, "failure", event.digest.headline);
          return;
        case "error":
          await set(event.change, "failure", `Review failed (round ${event.round}); see logs`);
          return;
      }
    },
  };
}
