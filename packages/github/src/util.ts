import { type RepoRef, redactText } from "@merge-safely/core";

/** Prefix of every check run this package writes. The source provider ignores these so the gate never reads itself. */
export const CHECK_NAME_PREFIX = "merge-safely/";
export const DEFAULT_CHECK_NAME = "merge-safely/verdict";
export const DEFAULT_HOST = "github.com";

/** GitHub's hard cap on check-run `output.summary` and `output.text`, and on review/comment bodies. */
export const GITHUB_TEXT_LIMIT = 65_535;

/**
 * Parse `owner/name` (or `host/owner/name`, or an `https://host/owner/name` URL) into a RepoRef.
 * Throws on anything else.
 */
export function parseRepo(input: string, host = DEFAULT_HOST): RepoRef {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((p) => p.length > 0);
  const valid = (s: string | undefined): s is string => typeof s === "string" && /^[A-Za-z0-9_.-]+$/.test(s);
  if (parts.length === 2 && valid(parts[0]) && valid(parts[1])) {
    return { host, owner: parts[0], name: parts[1] };
  }
  if (parts.length === 3 && valid(parts[1]) && valid(parts[2]) && parts[0]) {
    return { host: parts[0], owner: parts[1], name: parts[2] };
  }
  throw new Error(`invalid repository "${input}": expected owner/name`);
}

/** Stable, case-insensitive key for a repository: `host/owner/name`, lowercased (GitHub names are case-insensitive). */
export function repoKey(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
}

const TRUNCATION_NOTE = "\n\n_… truncated by merge-safely_";

/**
 * Truncate markdown to at most `max` UTF-16 code units (GitHub's limit unit) without splitting a
 * surrogate pair, closing an open ``` fence, and appending a truncation note.
 */
export function truncateMarkdown(md: string, max: number = GITHUB_TEXT_LIMIT): string {
  if (md.length <= max) return md;
  const fenceClose = "\n```";
  const reserve = TRUNCATION_NOTE.length + fenceClose.length;
  if (max <= reserve) return safeSlice(md, max);
  let cut = safeSlice(md, max - reserve);
  const fences = cut.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2 === 1) cut += fenceClose;
  return cut + TRUNCATION_NOTE;
}

/** Plain truncation to `max` code units that never leaves a lone high surrogate. */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const code = s.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Truncate a single line/field with an ellipsis, staying within `max`. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${safeSlice(s, Math.max(0, max - 1))}…`;
}

/**
 * Mask secret shapes before text leaves the process in a check run or comment (error messages can
 * echo request headers). Delegates to core's redactor in aggressive mode (GitHub/GitLab/npm tokens,
 * provider/cloud/chat keys, Authorization/api-key headers, URL credentials and PEM blocks).
 */
export function redactSecrets(s: string): string {
  return redactText(s, { aggressive: true, replacement: "[redacted]" });
}

/** Map with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
