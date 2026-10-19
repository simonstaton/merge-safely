import type { RepoRef, Verdict } from "@merge-safely/core";
import { type GithubIdentity, isOwnApp } from "./identity.js";
import { type CheckConclusion, type CheckRunData, collectPages, type OctokitLike } from "./octokit.js";

/**
 * Our check run for (name, headSha): the newest by id among runs created by OUR app. Runs with the
 * same name from any other app (or any other workflow identity) are ignored, so they can neither
 * forge a stored verdict nor be updated by us. Callers update the result, so each SHA converges on
 * one run per name.
 */
export async function findCheckRun(
  octokit: OctokitLike,
  repo: RepoRef,
  headSha: string,
  name: string,
  who: GithubIdentity,
): Promise<CheckRunData | null> {
  const runs = await collectPages(
    async (page, per_page) =>
      (
        await octokit.checks.listForRef({
          owner: repo.owner,
          repo: repo.name,
          ref: headSha,
          check_name: name,
          filter: "all",
          per_page,
          page,
        })
      ).data.check_runs,
    { maxItems: 300 },
  );
  let best: CheckRunData | null = null;
  for (const r of runs) {
    if (r.name !== name || r.head_sha !== headSha || !isOwnApp(r.app, who)) continue;
    if (!best || r.id > best.id) best = r;
  }
  return best;
}

/**
 * Verdict -> check conclusion. `pass` is `success`; `block` is `failure`; an undecided (`pending`)
 * or `contested` verdict is `action_required`, so a merge bot requiring success waits for a human.
 */
export function conclusionForVerdict(v: Pick<Verdict, "decision" | "contested">): CheckConclusion {
  if (v.decision === "block") return "failure";
  if (v.decision === "pending" || v.contested) return "action_required";
  return "success";
}
