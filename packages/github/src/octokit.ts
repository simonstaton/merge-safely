/**
 * Minimal structural view of the Octokit REST client: only the methods and response fields this
 * package reads. Every adapter takes an `OctokitLike`, so tests inject fakes and callers can pass a
 * real `@octokit/rest` instance (assignability is checked in `octokit.test.ts`).
 *
 * Methods are declared with method syntax on purpose: parameters are then checked bivariantly, which
 * is what lets the real, much wider Octokit signatures satisfy these narrow ones.
 */

export interface ApiResponse<T> {
  data: T;
}

export interface UserData {
  login: string;
  id: number;
  type?: string;
}

export interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  draft?: boolean;
  user: UserData | null;
  labels: { name: string }[];
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface PullFileData {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface CommitData {
  sha: string;
  commit: { message: string };
}

export interface CheckRunOutputData {
  title: string | null;
  summary: string | null;
  text: string | null;
}

export interface CheckRunData {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  output: CheckRunOutputData;
}

export type CheckAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title?: string;
  message: string;
};

export type CheckRunOutputParams = {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckAnnotation[];
};

export type CheckRunCreateParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  started_at?: string;
  completed_at?: string;
  details_url?: string;
  output?: CheckRunOutputParams;
};

export type CheckRunUpdateParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  started_at?: string;
  completed_at?: string;
  details_url?: string;
  output?: CheckRunOutputParams;
};

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required";

export interface ReviewData {
  id: number;
  body: string;
  commit_id: string | null;
  user: { login: string; type?: string } | null;
}

export interface IssueCommentData {
  id: number;
  body?: string;
  user: { login: string; type?: string } | null;
}

export interface ReviewCommentData {
  id: number;
  body: string;
  path: string;
  user: { login: string } | null;
}

export type ReviewCommentParams = {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
};

export type RepoParams = {
  owner: string;
  repo: string;
};

export type PageParams = {
  per_page?: number;
  page?: number;
};

export interface OctokitLike {
  pulls: {
    get(params: RepoParams & { pull_number: number }): Promise<ApiResponse<PullRequestData>>;
    listFiles(params: RepoParams & PageParams & { pull_number: number }): Promise<ApiResponse<PullFileData[]>>;
    listCommits(params: RepoParams & PageParams & { pull_number: number }): Promise<ApiResponse<CommitData[]>>;
    listReviews(params: RepoParams & PageParams & { pull_number: number }): Promise<ApiResponse<ReviewData[]>>;
    listReviewComments(
      params: RepoParams & PageParams & { pull_number: number },
    ): Promise<ApiResponse<ReviewCommentData[]>>;
    createReview(
      params: RepoParams & {
        pull_number: number;
        commit_id?: string;
        body?: string;
        event?: "COMMENT" | "REQUEST_CHANGES";
        comments?: ReviewCommentParams[];
      },
    ): Promise<ApiResponse<{ id: number }>>;
  };
  repos: {
    getCombinedStatusForRef(
      params: RepoParams & PageParams & { ref: string },
    ): Promise<ApiResponse<{ statuses: { context: string; state: string }[] }>>;
    compareCommitsWithBasehead(
      params: RepoParams & PageParams & { basehead: string; mediaType?: { format?: string } },
    ): Promise<ApiResponse<{ files?: PullFileData[] }>>;
  };
  checks: {
    listForRef(
      params: RepoParams & PageParams & { ref: string; check_name?: string; filter?: "latest" | "all" },
    ): Promise<ApiResponse<{ total_count: number; check_runs: CheckRunData[] }>>;
    create(params: CheckRunCreateParams): Promise<ApiResponse<CheckRunData>>;
    update(params: CheckRunUpdateParams): Promise<ApiResponse<CheckRunData>>;
  };
  issues: {
    listComments(params: RepoParams & PageParams & { issue_number: number }): Promise<ApiResponse<IssueCommentData[]>>;
    createComment(params: RepoParams & { issue_number: number; body: string }): Promise<ApiResponse<{ id: number }>>;
  };
  teams: {
    getMembershipForUserInOrg(params: {
      org: string;
      team_slug: string;
      username: string;
    }): Promise<ApiResponse<{ state: string; role: string }>>;
  };
}

/** HTTP status of an Octokit RequestError (or anything shaped like one), else undefined. */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Collect a page-numbered list endpoint. Stops on a short page or once `maxItems` is reached,
 * so a hostile PR with thousands of comments cannot make us page forever.
 */
export async function collectPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
  opts: { perPage?: number; maxItems?: number } = {},
): Promise<T[]> {
  const perPage = opts.perPage ?? 100;
  const maxItems = opts.maxItems ?? 3000;
  const out: T[] = [];
  for (let page = 1; out.length < maxItems; page++) {
    const items = await fetchPage(page, perPage);
    out.push(...items);
    if (items.length < perPage) break;
  }
  return out.slice(0, maxItems);
}
