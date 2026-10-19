/**
 * In-memory fake of the OctokitLike surface. No network. Records every call so tests can assert on
 * exactly what would have been sent to GitHub.
 */
import type {
  CheckAnnotation,
  CheckRunCreateParams,
  CheckRunData,
  CheckRunUpdateParams,
  CommitData,
  IssueCommentData,
  OctokitLike,
  PageParams,
  PullFileData,
  PullRequestData,
  ReviewCommentData,
  ReviewCommentParams,
  ReviewData,
} from "../src/octokit.js";

export interface FakeState {
  pr: PullRequestData;
  files: PullFileData[];
  commits: CommitData[];
  reviews: (ReviewData & { event?: string; comments?: ReviewCommentParams[] })[];
  reviewComments: ReviewCommentData[];
  issueComments: IssueCommentData[];
  statuses: { context: string; state: string }[];
  checkRuns: (CheckRunData & { annotations: CheckAnnotation[]; details_url?: string })[];
  /** Diff text keyed by basehead, or an error to throw. */
  diffs: Record<string, string | Error>;
  /** JSON compare files keyed by basehead. */
  compareFiles: Record<string, PullFileData[]>;
  /** `org/team:login` -> membership state, or "404". */
  memberships: Record<string, string>;
  /** Make the next createReview call with comments fail with 422. */
  failReviewWithComments?: boolean;
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export function basePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    number: 7,
    title: "Add widget",
    body: "Adds a widget.",
    html_url: "https://github.com/acme/widgets/pull/7",
    draft: false,
    user: { login: "alice", id: 1, type: "User" },
    labels: [],
    head: { sha: "head1", ref: "feature", repo: { full_name: "acme/widgets" } },
    base: { sha: "base1", ref: "main", repo: { full_name: "acme/widgets" } },
    additions: 10,
    deletions: 2,
    changed_files: 1,
    ...overrides,
  };
}

function page<T>(items: T[], params: PageParams): T[] {
  const perPage = params.per_page ?? 30;
  const p = params.page ?? 1;
  return items.slice((p - 1) * perPage, p * perPage);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function httpError(status: number, message = `HTTP ${status}`): Error {
  return new HttpError(status, message);
}

export function fakeOctokit(init: Partial<FakeState> = {}): { octokit: OctokitLike; state: FakeState; calls: Call[] } {
  const state: FakeState = {
    pr: basePr(),
    files: [
      { filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" },
    ],
    commits: [],
    reviews: [],
    reviewComments: [],
    issueComments: [],
    statuses: [],
    checkRuns: [],
    diffs: {},
    compareFiles: {},
    memberships: {},
    ...init,
  };
  const calls: Call[] = [];
  let nextId = 1000;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const rec = (method: string, params: object) => calls.push({ method, params: { ...params } });

  const octokit: OctokitLike = {
    pulls: {
      async get(params) {
        rec("pulls.get", params);
        return { data: state.pr };
      },
      async listFiles(params) {
        rec("pulls.listFiles", params);
        return { data: page(state.files, params) };
      },
      async listCommits(params) {
        rec("pulls.listCommits", params);
        return { data: page(state.commits, params) };
      },
      async listReviews(params) {
        rec("pulls.listReviews", params);
        return { data: page(state.reviews, params) };
      },
      async listReviewComments(params) {
        rec("pulls.listReviewComments", params);
        return { data: page(state.reviewComments, params) };
      },
      async createReview(params) {
        rec("pulls.createReview", params);
        if (state.failReviewWithComments && params.comments && params.comments.length > 0) {
          throw httpError(422, "Line could not be resolved");
        }
        const id = nextId++;
        state.reviews.push({
          id,
          body: params.body ?? "",
          commit_id: params.commit_id ?? null,
          user: { login: "merge-safely[bot]", type: "Bot" },
          event: params.event,
          comments: params.comments,
        });
        return { data: { id } };
      },
    },
    repos: {
      async getCombinedStatusForRef(params) {
        rec("repos.getCombinedStatusForRef", params);
        return { data: { statuses: page(state.statuses, params) } };
      },
      async compareCommitsWithBasehead(params) {
        rec("repos.compareCommitsWithBasehead", params);
        if (params.mediaType?.format === "diff") {
          const d = state.diffs[params.basehead];
          if (d instanceof Error) throw d;
          if (d === undefined) throw httpError(404);
          // Real Octokit returns the raw diff string as `data` for the diff media type.
          return { data: d as unknown as { files?: PullFileData[] } };
        }
        return { data: { files: state.compareFiles[params.basehead] ?? [] } };
      },
    },
    checks: {
      async listForRef(params) {
        rec("checks.listForRef", params);
        const runs = state.checkRuns.filter(
          (r) => r.head_sha === params.ref && (params.check_name === undefined || r.name === params.check_name),
        );
        return { data: { total_count: runs.length, check_runs: page(runs, params) } };
      },
      async create(params: CheckRunCreateParams) {
        rec("checks.create", params);
        const now = tick();
        const run = {
          id: nextId++,
          name: params.name,
          head_sha: params.head_sha,
          status: params.conclusion ? "completed" : (params.status ?? "queued"),
          conclusion: params.conclusion ?? null,
          started_at: params.started_at ?? now,
          completed_at: params.conclusion ? (params.completed_at ?? now) : null,
          details_url: params.details_url,
          output: {
            title: params.output?.title ?? null,
            summary: params.output?.summary ?? null,
            text: params.output?.text ?? null,
          },
          annotations: [...(params.output?.annotations ?? [])],
        };
        state.checkRuns.push(run);
        return { data: run };
      },
      async update(params: CheckRunUpdateParams) {
        rec("checks.update", params);
        const run = state.checkRuns.find((r) => r.id === params.check_run_id);
        if (!run) throw httpError(404);
        if (params.status) run.status = params.status;
        if (params.status === "in_progress") {
          run.conclusion = null;
          run.completed_at = null;
        }
        if (params.conclusion) {
          run.status = "completed";
          run.conclusion = params.conclusion;
          run.completed_at = params.completed_at ?? tick();
        }
        if (params.details_url) run.details_url = params.details_url;
        if (params.output) {
          run.output = {
            title: params.output.title,
            summary: params.output.summary,
            text: params.output.text ?? run.output.text,
          };
          run.annotations.push(...(params.output.annotations ?? []));
        }
        return { data: run };
      },
    },
    issues: {
      async listComments(params) {
        rec("issues.listComments", params);
        return { data: page(state.issueComments, params) };
      },
      async createComment(params) {
        rec("issues.createComment", params);
        const id = nextId++;
        state.issueComments.push({ id, body: params.body, user: { login: "merge-safely[bot]", type: "Bot" } });
        return { data: { id } };
      },
    },
    teams: {
      async getMembershipForUserInOrg(params) {
        rec("teams.getMembershipForUserInOrg", params);
        const s = state.memberships[`${params.org}/${params.team_slug}:${params.username}`];
        if (s === undefined || s === "404") throw httpError(404);
        if (s === "500") throw httpError(500);
        return { data: { state: s, role: "member" } };
      },
    },
  };
  return { octokit, state, calls };
}

export function callsTo(calls: Call[], method: string): Call[] {
  return calls.filter((c) => c.method === method);
}
