/**
 * The Action's inputs (action.yml). Everything is read through `getInput`, so tests pass a plain map.
 * Values are validated here; nothing that could be a secret is ever echoed back in an error.
 */
import { posix } from "node:path";
import { POLICY_FILE } from "@merge-safely/cli";
import { actionError } from "./errors.js";

export type GetInput = (name: string) => string;

export interface ActionInputs {
  /** Raw YAML text of the `connections` input (parsed later, only when a review needs it). */
  connections: string;
  /** Repository-relative policy path. */
  policyPath: string;
  /** True when `policy` was set to something other than the default. */
  policyExplicit: boolean;
  githubToken: string;
  failOnBlock: boolean;
  store: "checkrun";
  slackWebhook?: string;
  concurrency: number;
  prNumber?: number;
  headSha?: string;
  /**
   * GitHub App slugs whose merge-safely check runs count as verdicts when this run reads them (merge queue,
   * check_run re-runs). The slug of the token's own app is always added at run time.
   */
  verdictAppSlugs: string[];
}

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_VERDICT_APP_SLUGS = ["github-actions"];

/** `a, b ,c` -> ["a","b","c"]; each a GitHub App slug. */
export function parseSlugs(raw: string): string[] {
  const v = raw.trim();
  if (v === "") return [...DEFAULT_VERDICT_APP_SLUGS];
  const out: string[] = [];
  for (const part of v.split(/[,\s]+/)) {
    const s = part.trim().toLowerCase();
    if (s === "") continue;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(s)) {
      throw actionError("INPUT", `verdict-app-slugs: "${part}" is not a GitHub App slug (letters, digits, dashes)`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : [...DEFAULT_VERDICT_APP_SLUGS];
}
export const MAX_CONCURRENCY = 16;
export const STORES = ["checkrun"] as const;

function bool(name: string, raw: string, dflt: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "") return dflt;
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  throw actionError("INPUT", `${name} must be true or false (got "${raw.trim()}")`);
}

function int(name: string, raw: string, min: number, max: number): number | undefined {
  const v = raw.trim();
  if (v === "") return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw actionError("INPUT", `${name} must be an integer from ${min} to ${max} (got "${v}")`);
  }
  return n;
}

/** Normalise a repository-relative path; refuse absolute paths and `..` so the API read stays inside the repo. */
export function normalisePolicyPath(raw: string): string {
  const v = raw.trim();
  if (v === "") return POLICY_FILE;
  const p = posix.normalize(v.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (p.startsWith("/") || p === ".." || p.startsWith("../") || p === ".") {
    throw actionError("INPUT", `policy must be a path inside the repository, like ${POLICY_FILE} (got "${v}")`);
  }
  return p;
}

export function readInputs(getInput: GetInput): ActionInputs {
  const policyRaw = getInput("policy");
  const policyPath = normalisePolicyPath(policyRaw);
  const store = (getInput("store").trim() || "checkrun") as (typeof STORES)[number];
  if (!STORES.includes(store)) {
    throw actionError(
      "INPUT",
      `store must be one of: ${STORES.join(", ")} (got "${store}"). The Action keeps verdicts in the check run; ` +
        "use the CLI or the App for other stores",
    );
  }
  const headSha = getInput("head-sha").trim();
  if (headSha !== "" && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(headSha)) {
    throw actionError("INPUT", "head-sha must be a full commit SHA (40 or 64 hex characters)");
  }
  const prNumber = int("pr-number", getInput("pr-number"), 1, Number.MAX_SAFE_INTEGER);
  const slackWebhook = getInput("slack-webhook").trim();
  return {
    connections: getInput("connections"),
    policyPath,
    policyExplicit: policyPath !== POLICY_FILE,
    githubToken: getInput("github-token").trim(),
    failOnBlock: bool("fail-on-block", getInput("fail-on-block"), true),
    store,
    ...(slackWebhook ? { slackWebhook } : {}),
    concurrency: int("concurrency", getInput("concurrency"), 1, MAX_CONCURRENCY) ?? DEFAULT_CONCURRENCY,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(headSha ? { headSha: headSha.toLowerCase() } : {}),
    verdictAppSlugs: parseSlugs(getInput("verdict-app-slugs")),
  };
}
