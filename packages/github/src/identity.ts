import type { Logger, Policy } from "@merge-safely/core";
import type { AppData, OctokitLike } from "./octokit.js";
import { DEFAULT_CHECK_NAME } from "./util.js";

/**
 * Who "we" are on GitHub. Check runs, the round-history index comment and review/comment markers
 * only count when they were written by this identity, so another App, a bot or a human cannot forge
 * a verdict or suppress the gate's output by reusing our check name or markers.
 *
 * - App mode: discovered with `GET /app` (slug + id) unless given explicitly.
 * - Action mode (`GITHUB_TOKEN`): `GET /app` is refused, so we fall back to the `github-actions` app.
 *   That is weaker: any workflow in the repo runs as `github-actions` and can write the same check
 *   run name. Pin the check's source app in rulesets and prefer the App for protected branches.
 */
export interface IdentityOptions {
  /** App slug, e.g. `merge-safely`. Overrides discovery. */
  appSlug?: string;
  /** Numeric App id. When set, check runs must match it (stronger than the slug). */
  appId?: number;
  /** Login our comments/reviews are posted as. Defaults to `<appSlug>[bot]`. */
  botLogin?: string;
}

export interface GithubIdentity {
  appSlug: string;
  appId?: number;
  botLogin: string;
}

export const GITHUB_ACTIONS_IDENTITY: GithubIdentity = {
  appSlug: "github-actions",
  appId: 15368,
  botLogin: "github-actions[bot]",
};

/** Resolve the identity once: explicit options win, then `GET /app`, then the github-actions fallback. */
export async function resolveIdentity(
  octokit: OctokitLike,
  opts: IdentityOptions = {},
  logger?: Logger,
): Promise<GithubIdentity> {
  if (opts.appSlug || opts.appId !== undefined) {
    const appSlug = opts.appSlug ?? GITHUB_ACTIONS_IDENTITY.appSlug;
    return {
      appSlug,
      ...(opts.appId !== undefined ? { appId: opts.appId } : {}),
      botLogin: opts.botLogin ?? `${appSlug}[bot]`,
    };
  }
  let app: AppData | null = null;
  try {
    app = (await octokit.apps.getAuthenticated()).data;
  } catch (_err: unknown) {
    app = null; // token auth (GITHUB_TOKEN / PAT): no App JWT available
  }
  if (app?.slug) {
    return { appSlug: app.slug, appId: app.id, botLogin: opts.botLogin ?? `${app.slug}[bot]` };
  }
  logger?.debug("merge-safely: GET /app unavailable, assuming the github-actions identity");
  return { ...GITHUB_ACTIONS_IDENTITY, ...(opts.botLogin ? { botLogin: opts.botLogin } : {}) };
}

/** Memoised resolver so each adapter calls `GET /app` at most once. */
export function lazyIdentity(octokit: OctokitLike, opts: IdentityOptions = {}, logger?: Logger) {
  let p: Promise<GithubIdentity> | null = null;
  return (): Promise<GithubIdentity> => {
    if (!p) {
      p = resolveIdentity(octokit, opts, logger).catch((err: unknown) => {
        p = null;
        throw err;
      });
    }
    return p;
  };
}

/** True when the check run was created by our App (id when known, else slug). */
export function isOwnApp(app: AppData | null, who: GithubIdentity): boolean {
  if (!app) return false;
  if (who.appId !== undefined) return app.id === who.appId;
  return (app.slug ?? "").toLowerCase() === who.appSlug.toLowerCase();
}

/** True when a review/comment was posted by our bot login. */
export function isOwnUser(user: { login: string } | null, who: GithubIdentity): boolean {
  return (user?.login ?? "").toLowerCase() === who.botLogin.toLowerCase();
}

/** Single source for the check name: explicit override, then policy.reporting.checkName, then the default. */
export function resolveCheckName(checkName?: string, policy?: Pick<Policy, "reporting">): string {
  return checkName ?? policy?.reporting.checkName ?? DEFAULT_CHECK_NAME;
}
