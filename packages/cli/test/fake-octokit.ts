/** A minimal in-memory GitHub for the PR flow: one PR, its files, check runs, statuses, reviews and comments. */
import type { CheckRunData, OctokitLike, PullFileData } from "@merge-safely/github";

export interface FakeGithubState {
  headSha: string;
  baseSha: string;
  files: PullFileData[];
  checkRuns: CheckRunData[];
  /** Every check-run status written, in order (create and update). */
  checkStatusLog: string[];
  statuses: { sha: string; state: string; context?: string }[];
  reviews: { body?: string; event?: string }[];
  comments: { id: number; body: string }[];
}

const APP = { id: 4242, slug: "merge-safely" };

export function fakeOctokit(init: Pick<FakeGithubState, "headSha" | "baseSha" | "files">): {
  octokit: OctokitLike;
  state: FakeGithubState;
} {
  const state: FakeGithubState = {
    ...init,
    checkRuns: [],
    checkStatusLog: [],
    statuses: [],
    reviews: [],
    comments: [],
  };
  let nextId = 1;
  const ok = <T>(data: T) => Promise.resolve({ data });
  const diff = () =>
    state.files
      .map(
        (f) =>
          `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch ?? ""}\n`,
      )
      .join("");
  const octokit: OctokitLike = {
    pulls: {
      get: () =>
        ok({
          number: 7,
          title: "Add multipliers",
          body: "Adds v0..v44.",
          html_url: "https://github.com/acme/app/pull/7",
          draft: false,
          user: { login: "ada", id: 1, type: "User" },
          labels: [],
          head: { sha: state.headSha, ref: "feature", repo: { full_name: "acme/app" } },
          base: { sha: state.baseSha, ref: "main", repo: { full_name: "acme/app" } },
          additions: state.files.reduce((s, f) => s + f.additions, 0),
          deletions: state.files.reduce((s, f) => s + f.deletions, 0),
          changed_files: state.files.length,
        }),
      listFiles: (p) => ok((p.page ?? 1) === 1 ? state.files : []),
      listCommits: (p) =>
        ok((p.page ?? 1) === 1 ? [{ sha: state.headSha, commit: { message: "feat: multipliers" } }] : []),
      listReviews: () => ok([]),
      listReviewComments: () => ok([]),
      createReview: (p) => {
        state.reviews.push({ ...(p.body ? { body: p.body } : {}), ...(p.event ? { event: p.event } : {}) });
        return ok({ id: nextId++ });
      },
      dismissReview: () => ok({ id: nextId++ }),
    },
    repos: {
      createCommitStatus: (p) => {
        state.statuses.push({ sha: p.sha, state: p.state, ...(p.context ? { context: p.context } : {}) });
        return ok({ id: nextId++ });
      },
      getCombinedStatusForRef: () => ok({ statuses: [] }),
      compareCommitsWithBasehead: (p) =>
        (p.mediaType?.format === "diff" ? ok(diff()) : ok({ files: state.files })) as ReturnType<
          OctokitLike["repos"]["compareCommitsWithBasehead"]
        >,
    },
    checks: {
      listForRef: (p) => {
        const runs = state.checkRuns.filter(
          (r) => r.head_sha === p.ref && (p.check_name === undefined || r.name === p.check_name),
        );
        return ok({ total_count: runs.length, check_runs: (p.page ?? 1) === 1 ? runs : [] });
      },
      create: (p) => {
        const run: CheckRunData = {
          id: nextId++,
          name: p.name,
          head_sha: p.head_sha,
          status: p.conclusion ? "completed" : (p.status ?? "queued"),
          conclusion: p.conclusion ?? null,
          started_at: p.started_at ?? null,
          completed_at: p.completed_at ?? null,
          output: { title: p.output?.title ?? null, summary: p.output?.summary ?? null, text: p.output?.text ?? null },
          app: APP,
        };
        state.checkRuns.push(run);
        state.checkStatusLog.push(run.status);
        return ok(run);
      },
      update: (p) => {
        const run = state.checkRuns.find((r) => r.id === p.check_run_id);
        if (!run) return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
        if (p.status) run.status = p.status;
        if (p.conclusion) {
          // GitHub: setting a conclusion completes the run.
          run.conclusion = p.conclusion;
          run.status = "completed";
        }
        if (p.completed_at) run.completed_at = p.completed_at;
        if (p.output) {
          run.output = {
            title: p.output.title,
            summary: p.output.summary,
            text: p.output.text ?? run.output.text,
          };
        }
        state.checkStatusLog.push(run.status);
        return ok(run);
      },
    },
    issues: {
      listComments: (p) =>
        ok((p.page ?? 1) === 1 ? state.comments.map((c) => ({ ...c, user: { login: "merge-safely[bot]" } })) : []),
      createComment: (p) => {
        const c = { id: nextId++, body: p.body };
        state.comments.push(c);
        return ok({ id: c.id });
      },
      updateComment: (p) => {
        const c = state.comments.find((x) => x.id === p.comment_id);
        if (c) c.body = p.body;
        return ok({ id: p.comment_id });
      },
    },
    apps: { getAuthenticated: () => ok(APP) },
    teams: {
      getMembershipForUserInOrg: () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
    },
  };
  return { octokit, state };
}
