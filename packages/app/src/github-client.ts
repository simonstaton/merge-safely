/**
 * Octokit clients for the App, with Octokit's own logging routed through the JSON logger (and so through the
 * secret scrubber) instead of plain-text lines on stdout.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { AppLogger } from "./logger.js";
import type { AppOctokit } from "./run-job.js";

export interface GithubClientOptions {
  appId: string;
  privateKey: string;
  baseUrl?: string;
  logger: AppLogger;
}

const USER_AGENT = "merge-safely-app";

function octokitLog(logger: AppLogger) {
  const l = logger.child({ component: "octokit" });
  return {
    debug: (msg: string) => l.debug(msg),
    info: (msg: string) => l.debug(msg), // request lines are noise at info
    warn: (msg: string) => l.warn(msg),
    error: (msg: string) => l.error(msg),
  };
}

export function installationClient(opts: GithubClientOptions, installationId: number): AppOctokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: opts.appId, privateKey: opts.privateKey, installationId },
    userAgent: USER_AGENT,
    log: octokitLog(opts.logger),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  }) as unknown as AppOctokit;
}

/** Every installation of the App (JWT auth), for the boot-time sync. */
export async function listAppInstallations(opts: GithubClientOptions): Promise<{ id: number; account: string }[]> {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: opts.appId, privateKey: opts.privateKey },
    userAgent: USER_AGENT,
    log: octokitLog(opts.logger),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
  const out: { id: number; account: string }[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data } = await octokit.apps.listInstallations({ per_page: 100, page });
    for (const i of data) {
      const acc: unknown = i.account;
      const rec =
        typeof acc === "object" && acc !== null ? (acc as { login?: unknown; name?: unknown; slug?: unknown }) : {};
      const account = [rec.login, rec.slug, rec.name].find((v): v is string => typeof v === "string") ?? "unknown";
      out.push({ id: i.id, account });
    }
    if (data.length < 100) break;
  }
  return out;
}
