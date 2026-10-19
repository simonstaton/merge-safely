import type { Exec } from "./exec.js";

export type TokenSource = "GITHUB_TOKEN" | "GH_TOKEN" | "gh";

export interface DiscoveredToken {
  token: string;
  source: TokenSource;
}

/**
 * GitHub token precedence: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token` when the GitHub CLI is installed
 * and logged in. Returns undefined when none is available. The token is never printed.
 */
export async function discoverGithubToken(
  env: NodeJS.ProcessEnv,
  exec: Exec,
  opts: { allowGh?: boolean } = {},
): Promise<DiscoveredToken | undefined> {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const v = env[name]?.trim();
    if (v) return { token: v, source: name };
  }
  if (opts.allowGh === false) return undefined;
  const r = await exec("gh", ["auth", "token"], { timeoutMs: 10_000 });
  const t = r.code === 0 ? r.stdout.trim() : "";
  if (t && !/\s/.test(t)) return { token: t, source: "gh" };
  return undefined;
}

export type TokenIdentity = "app" | "user";

/**
 * Cheap, offline probe: App installation tokens (and the Actions `GITHUB_TOKEN`, which is one) start with `ghs_`.
 * Inside GitHub Actions the `GITHUB_TOKEN` variable is treated as an App token too. Everything else (PATs `ghp_` /
 * `github_pat_`, `gh` OAuth tokens `gho_`) is a user token, which cannot write check runs.
 */
export function tokenIdentity(t: DiscoveredToken, env: NodeJS.ProcessEnv): TokenIdentity {
  if (t.token.startsWith("ghs_")) return "app";
  // A PAT or OAuth token passed through GITHUB_TOKEN inside Actions is still a user token.
  if (/^(ghp_|github_pat_|gho_|ghu_)/.test(t.token)) return "user";
  if (t.source === "GITHUB_TOKEN" && env.GITHUB_ACTIONS === "true") return "app";
  return "user";
}
