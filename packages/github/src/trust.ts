import type { Policy, Principal, RepoRef, TrustClass, TrustProvider } from "@merge-safely/core";
import { errorStatus, type OctokitLike } from "./octokit.js";

/**
 * Trust providers. Trust is used ONLY for bypass and escalation routing; it never changes a tier.
 *
 * Entries are bare logins (`alice`, `@alice`) or teams (`org/team-slug`). Precedence, highest first:
 * 1. `blocked` (login or team) → "blocked"
 * 2. bots/agents → "standard" when `botsAreStandard` (default true): an automated author is never trusted
 * 3. `trusted` (login or team) → "trusted"
 * 4. otherwise "standard"
 * Lookup failures other than 404 fail closed (not a member) and are not cached.
 */
export interface GithubTeamsTrustOptions {
  octokit: OctokitLike;
  trusted: string[];
  blocked?: string[];
  botsAreStandard?: boolean;
  /** Membership cache TTL. Defaults to 5 minutes. */
  cacheTtlMs?: number;
  now?: () => number;
}

export const TEAM_CACHE_TTL_MS = 5 * 60 * 1000;

interface Parsed {
  logins: Set<string>;
  teams: { org: string; slug: string }[];
}

function parseEntries(entries: string[]): Parsed {
  const logins = new Set<string>();
  const teams: { org: string; slug: string }[] = [];
  for (const raw of entries) {
    const e = raw.trim().replace(/^@/, "");
    if (!e) continue;
    const slash = e.indexOf("/");
    if (slash > 0 && slash < e.length - 1) teams.push({ org: e.slice(0, slash), slug: e.slice(slash + 1) });
    else logins.add(e.toLowerCase());
  }
  return { logins, teams };
}

const isAutomated = (p: Principal) => p.kind === "bot" || p.kind === "agent";

export function githubTeamsTrust(opts: GithubTeamsTrustOptions): TrustProvider {
  const trusted = parseEntries(opts.trusted);
  const blocked = parseEntries(opts.blocked ?? []);
  const botsAreStandard = opts.botsAreStandard ?? true;
  const ttl = opts.cacheTtlMs ?? TEAM_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { member: boolean; at: number }>();

  async function isMember(team: { org: string; slug: string }, login: string): Promise<boolean> {
    const key = `${team.org}/${team.slug}:${login}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.member;
    let member: boolean;
    try {
      const { data } = await opts.octokit.teams.getMembershipForUserInOrg({
        org: team.org,
        team_slug: team.slug,
        username: login,
      });
      member = data.state === "active"; // "pending" invitations are not members yet
    } catch (err: unknown) {
      if (errorStatus(err) !== 404) return false; // fail closed, do not cache transient errors
      member = false;
    }
    cache.set(key, { member, at: now() });
    return member;
  }

  async function matches(p: Parsed, login: string): Promise<boolean> {
    if (p.logins.has(login.toLowerCase())) return true;
    for (const t of p.teams) if (await isMember(t, login)) return true;
    return false;
  }

  return {
    async classify(author: Principal, _repo: RepoRef): Promise<TrustClass> {
      if (await matches(blocked, author.login)) return "blocked";
      if (botsAreStandard && isAutomated(author)) return "standard";
      if (await matches(trusted, author.login)) return "trusted";
      return "standard";
    },
  };
}

/** Static allowlist, no network. Team entries (`org/slug`) cannot be checked here and never match. */
export function allowlistTrust(opts: {
  trusted: string[];
  blocked?: string[];
  botsAreStandard?: boolean;
}): TrustProvider {
  const trusted = parseEntries(opts.trusted).logins;
  const blocked = parseEntries(opts.blocked ?? []).logins;
  const botsAreStandard = opts.botsAreStandard ?? true;
  return {
    async classify(author: Principal): Promise<TrustClass> {
      const login = author.login.toLowerCase();
      if (blocked.has(login)) return "blocked";
      if (botsAreStandard && isAutomated(author)) return "standard";
      return trusted.has(login) ? "trusted" : "standard";
    },
  };
}

/**
 * Build the TrustProvider named by `policy.trust.provider`.
 * - `github-teams` needs an octokit (with `members: read`); throws without one.
 * - `allowlist` uses bare logins only.
 * - `none` and `codeowners` (not implemented here) trust nobody; `blocked` logins still apply.
 */
export function trustFromPolicy(policy: Pick<Policy, "trust">, octokit?: OctokitLike): TrustProvider {
  const t = policy.trust;
  switch (t.provider) {
    case "github-teams":
      if (!octokit) throw new Error("trust.provider github-teams requires a GitHub client with members: read");
      return githubTeamsTrust({ octokit, trusted: t.trusted, blocked: t.blocked, botsAreStandard: t.botsAreStandard });
    case "allowlist":
      return allowlistTrust({ trusted: t.trusted, blocked: t.blocked, botsAreStandard: t.botsAreStandard });
    default:
      return allowlistTrust({ trusted: [], blocked: t.blocked, botsAreStandard: t.botsAreStandard });
  }
}
