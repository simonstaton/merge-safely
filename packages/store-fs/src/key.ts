import type { RepoRef, VerdictKey } from "@merge-safely/core";

/**
 * Canonical identity of a verdict: (host, owner, name, number, headSha).
 * Host and SHA are compared case-insensitively; owner and name are kept exact.
 */
export function verdictKeyString(k: VerdictKey): string {
  return `${changeKeyString(k.repo, k.number)}@${k.headSha.toLowerCase()}`;
}

export function changeKeyString(repo: RepoRef, number: number): string {
  return `${repo.host.toLowerCase()}/${repo.owner}/${repo.name}#${number}`;
}
