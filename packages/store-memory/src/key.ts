// Canonical copy. store-fs and store-sqlite hold byte-identical copies; a test in each fails if they drift.
import type { RepoRef, Verdict, VerdictKey } from "@merge-safely/core";

/**
 * Identity of a verdict is (host, owner, name, number, headSha), all compared case-insensitively:
 * GitHub treats owner and repo names case-insensitively, so `Acme/Widgets` and `acme/widgets` are one change.
 * Callers keep the original casing inside the stored verdict; only the key is folded.
 */
export function normaliseRepo(repo: RepoRef): RepoRef {
  return { host: repo.host.toLowerCase(), owner: repo.owner.toLowerCase(), name: repo.name.toLowerCase() };
}

/** Each part is lower-cased and percent-encoded, so the "/", "#" and "@" separators can never be ambiguous. */
function part(s: string): string {
  return encodeURIComponent(s.toLowerCase());
}

export function repoKeyString(repo: RepoRef): string {
  return `${part(repo.host)}/${part(repo.owner)}/${part(repo.name)}`;
}

export function changeKeyString(repo: RepoRef, number: number): string {
  return `${repoKeyString(repo)}#${number}`;
}

export function verdictKeyString(k: VerdictKey): string {
  return `${changeKeyString(k.repo, k.number)}@${part(k.headSha)}`;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return repoKeyString(a) === repoKeyString(b);
}

/** createdAt as epoch ms; an unparseable timestamp sorts first (as 0) in every store. */
export function createdAtMs(v: Verdict): number {
  const t = Date.parse(v.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** listForChange order, identical in every store: createdAt ascending, then lower-cased headSha. */
export function compareVerdicts(a: Verdict, b: Verdict): number {
  const d = createdAtMs(a) - createdAtMs(b);
  if (d !== 0) return d;
  const sa = a.headSha.toLowerCase();
  const sb = b.headSha.toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
