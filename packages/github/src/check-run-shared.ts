import type { RepoRef, Verdict } from "@merge-safely/core";
import { type CheckConclusion, type CheckRunData, collectPages, type OctokitLike } from "./octokit.js";

/**
 * The one check run for (name, headSha): the newest by id when several exist (e.g. created by an
 * older version or a re-run). Callers update it, so each SHA converges on exactly one run per name.
 */
export async function findCheckRun(
  octokit: OctokitLike,
  repo: RepoRef,
  headSha: string,
  name: string,
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
    if (r.name !== name || r.head_sha !== headSha) continue;
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
