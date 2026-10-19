import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/**
 * The exact GitHub App permission set Merge Safely needs (design section 8, least privilege).
 *
 * - `checks: write`        create and update the `merge-safely/*` check run (the signal and the verdict store).
 * - `pull_requests: write` post the review digest and inline comments; read PR metadata, files and commits.
 * - `contents: read`       read diffs, commit statuses and check runs; check out the head SHA.
 * - `members: read`        ONLY when `trust.provider: github-teams` is enabled (team membership lookups).
 *                          Drop it from the App manifest otherwise.
 * - `metadata: read`       mandatory for every App.
 *
 * The App never needs `contents: write`, `administration`, `statuses: write` or `workflows`.
 * Subscribe to the `pull_request`, `check_run` and `check_suite` webhook events.
 * Note: the Checks API is App-only. A PAT cannot write check runs; use `commitStatusReporter` and a local store.
 */
export const APP_PERMISSIONS = {
  checks: "write",
  pull_requests: "write",
  contents: "read",
  members: "read",
  metadata: "read",
} as const;

/** `APP_PERMISSIONS` minus `members`, for installations that do not use team-based trust. */
export const APP_PERMISSIONS_WITHOUT_TEAMS = {
  checks: "write",
  pull_requests: "write",
  contents: "read",
  metadata: "read",
} as const;

export interface ClientOptions {
  /** GitHub Enterprise Server API root, e.g. `https://ghe.example.com/api/v3`. */
  baseUrl?: string;
  userAgent?: string;
}

const USER_AGENT = "merge-safely";

/** An Octokit authenticated with a token (Actions `GITHUB_TOKEN`, a PAT, or an installation token). */
export function octokitFromToken(token: string, opts: ClientOptions = {}): Octokit {
  return new Octokit({ auth: token, userAgent: opts.userAgent ?? USER_AGENT, baseUrl: opts.baseUrl });
}

/** An Octokit authenticated as one App installation. Installation tokens are minted and refreshed by auth-app. */
export function createAppOctokit(
  opts: { appId: string | number; privateKey: string; installationId: number } & ClientOptions,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: opts.appId, privateKey: opts.privateKey, installationId: opts.installationId },
    userAgent: opts.userAgent ?? USER_AGENT,
    baseUrl: opts.baseUrl,
  });
}

/** An Octokit authenticated as the App itself (JWT), for app-level endpoints such as listing installations. */
export function createAppJwtOctokit(appId: string | number, privateKey: string, opts: ClientOptions = {}): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
    userAgent: opts.userAgent ?? USER_AGENT,
    baseUrl: opts.baseUrl,
  });
}
