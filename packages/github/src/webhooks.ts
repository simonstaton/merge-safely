import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChangeRef } from "@merge-safely/core";
import { CHECK_NAME_PREFIX, DEFAULT_HOST } from "./util.js";

/**
 * Verify `X-Hub-Signature-256` (`sha256=<hex>`) over the raw request body. Timing-safe.
 * Returns false for a missing/malformed header or an empty secret; never throws.
 * Pass the exact bytes GitHub sent: re-serialised JSON will not verify.
 */
export function verifyWebhookSignature(
  secret: string,
  payload: string | Buffer,
  signature256: string | undefined,
): boolean {
  if (!secret || !signature256) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature256.trim());
  if (!m?.[1]) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review", "labeled"] as const;

export interface WebhookChange {
  ref: ChangeRef;
  headSha?: string;
  action: string;
  /** Set for draft PRs. Callers should skip reviewing until `ready_for_review`. */
  draft?: true;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const str = (x: unknown): string | undefined => (typeof x === "string" && x.length > 0 ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isInteger(x) && x > 0 ? x : undefined);

function repoFrom(payload: Record<string, unknown>): ChangeRef["repo"] | null {
  const r = payload.repository;
  if (!isObj(r)) return null;
  const owner = isObj(r.owner) ? str(r.owner.login) : undefined;
  const name = str(r.name);
  if (!owner || !name) return null;
  let host = DEFAULT_HOST;
  const htmlUrl = str(r.html_url);
  if (htmlUrl) {
    try {
      host = new URL(htmlUrl).host || DEFAULT_HOST;
    } catch (_err: unknown) {
      host = DEFAULT_HOST;
    }
  }
  return { host, owner, name };
}

function firstPr(x: unknown): number | undefined {
  if (!Array.isArray(x)) return undefined;
  for (const pr of x) if (isObj(pr) && num(pr.number)) return num(pr.number);
  return undefined;
}

/**
 * Map a webhook delivery to the change it concerns, or null when it is not one we review.
 * - `pull_request`: opened, synchronize, reopened, ready_for_review, labeled. Draft PRs are returned with
 *   `draft: true` (except on ready_for_review) so the caller can skip them deliberately.
 * - `check_run` / `check_suite` with action `rerequested` (the "Re-run" button). Check runs not named
 *   with the `merge-safely/` prefix are ignored. Fork PRs arrive with an empty `pull_requests` list on
 *   check events; those return null (re-run by pushing, or via the CLI).
 */
export function changeRefFromEvent(
  name: string,
  payload: unknown,
  opts: { checkNamePrefix?: string } = {},
): WebhookChange | null {
  if (!isObj(payload)) return null;
  const action = str(payload.action);
  const repo = repoFrom(payload);
  if (!action || !repo) return null;

  if (name === "pull_request") {
    if (!(PULL_REQUEST_ACTIONS as readonly string[]).includes(action)) return null;
    const pr = payload.pull_request;
    if (!isObj(pr)) return null;
    const number = num(pr.number) ?? num(payload.number);
    if (!number) return null;
    const headSha = isObj(pr.head) ? str(pr.head.sha) : undefined;
    const out: WebhookChange = { ref: { repo, number }, action, ...(headSha ? { headSha } : {}) };
    if (pr.draft === true && action !== "ready_for_review") out.draft = true;
    return out;
  }

  if (name === "check_run" || name === "check_suite") {
    if (action !== "rerequested") return null;
    const obj = payload[name];
    if (!isObj(obj)) return null;
    if (name === "check_run") {
      const prefix = opts.checkNamePrefix ?? CHECK_NAME_PREFIX;
      const checkName = str(obj.name);
      if (!checkName?.startsWith(prefix)) return null;
    }
    const number = firstPr(obj.pull_requests);
    if (!number) return null;
    const headSha = str(obj.head_sha);
    return { ref: { repo, number }, action, ...(headSha ? { headSha } : {}) };
  }

  return null;
}
