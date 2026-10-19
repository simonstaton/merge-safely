import type { Change, ChangedFile, ChangeRef, RepoRef, SourceProvider } from "@merge-safely/core";

export interface SourceFixture {
  change: Change;
  /** Full base...head diff for `change.headSha`. */
  diff: string;
  /** Full base...head diffs for other (older or newer) head SHAs, for `getDiff(ref, { headSha })`. */
  diffs?: Record<string, string>;
  /** Delta diffs keyed by `sinceSha`. */
  deltas?: Record<string, string>;
  commitMessages?: string[];
  comments?: string[];
}

export type SourceCall =
  | { method: "getChange"; ref: ChangeRef }
  | { method: "getDiff"; ref: ChangeRef; opts?: { sinceSha?: string; headSha?: string } }
  | { method: "getUntrustedContext"; ref: ChangeRef }
  | { method: "listOpenChanges"; repo: RepoRef };

export interface FakeSource extends SourceProvider {
  /** Every call, in order. */
  readonly calls: SourceCall[];
  /** The live fixtures; change `fixtures[i].change.headSha` (and add the old head to `diffs`) to simulate a push. */
  readonly fixtures: SourceFixture[];
  getUntrustedContext(ref: ChangeRef): Promise<{ commitMessages: string[]; comments: string[] }>;
  listOpenChanges(repo: RepoRef): AsyncIterable<ChangeRef>;
}

export const DEFAULT_REPO: RepoRef = { host: "github.com", owner: "acme", name: "app" };

const sameRepo = (a: RepoRef, b: RepoRef) => a.host === b.host && a.owner === b.owner && a.name === b.name;

/**
 * A SourceProvider over in-memory fixtures. Values are cloned on the way out so a pipeline cannot mutate the
 * fixture. Like the GitHub source, `getDiff` with a pinned `headSha` returns the diff for that SHA: the
 * fixture `diff` when it is the current head, else `diffs[headSha]`. It throws only for a SHA it has no
 * diff for, and for a `sinceSha` with no `deltas` entry.
 */
export function fakeSource(fixture: SourceFixture | SourceFixture[]): FakeSource {
  const fixtures = Array.isArray(fixture) ? fixture : [fixture];
  const calls: SourceCall[] = [];
  const find = (ref: ChangeRef): SourceFixture => {
    const f = fixtures.find((x) => x.change.number === ref.number && sameRepo(x.change.repo, ref.repo));
    if (!f) throw new Error(`fake source: no change ${ref.repo.owner}/${ref.repo.name}#${ref.number}`);
    return f;
  };
  return {
    calls,
    fixtures,
    async getChange(ref) {
      calls.push({ method: "getChange", ref });
      return structuredClone(find(ref).change);
    },
    async getDiff(ref, opts) {
      calls.push({ method: "getDiff", ref, ...(opts ? { opts } : {}) });
      const f = find(ref);
      if (opts?.sinceSha) {
        const delta = f.deltas?.[opts.sinceSha];
        if (delta === undefined) throw new Error(`fake source: no delta fixture since ${opts.sinceSha}`);
        return delta;
      }
      const head = opts?.headSha ?? f.change.headSha;
      const pinned = f.diffs?.[head];
      if (pinned !== undefined) return pinned;
      if (head === f.change.headSha) return f.diff;
      throw new Error(`fake source: no diff fixture for head ${head}`);
    },
    async getUntrustedContext(ref) {
      calls.push({ method: "getUntrustedContext", ref });
      const f = find(ref);
      return { commitMessages: [...(f.commitMessages ?? [])], comments: [...(f.comments ?? [])] };
    },
    async *listOpenChanges(repo) {
      calls.push({ method: "listOpenChanges", repo });
      for (const f of fixtures) {
        if (sameRepo(f.change.repo, repo) && !f.change.draft) yield { repo: f.change.repo, number: f.change.number };
      }
    },
  };
}

/** A deterministic 40-hex SHA from a seed, for readable fixtures. */
export function fakeSha(seed: string): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

export function makeFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", additions: 1, deletions: 0, ...overrides };
}

/** A believable open PR. `stats` is computed from `files` unless given. */
export function makeChange(overrides: Partial<Change> = {}): Change {
  const files = overrides.files ?? [makeFile("src/index.ts")];
  const number = overrides.number ?? 1;
  const repo = overrides.repo ?? DEFAULT_REPO;
  return {
    repo,
    number,
    headSha: fakeSha(`head:${number}`),
    baseSha: fakeSha(`base:${number}`),
    baseRef: "main",
    headRef: `feature/${number}`,
    title: "Fix an edge case",
    body: "Small fix with a test.",
    author: { kind: "human", login: "octocat", id: 1 },
    labels: [],
    draft: false,
    ciStatus: "success",
    url: `https://${repo.host}/${repo.owner}/${repo.name}/pull/${number}`,
    ...overrides,
    files,
    stats: overrides.stats ?? {
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      files: files.length,
    },
  };
}

export function changeRef(change: Change): ChangeRef {
  return { repo: change.repo, number: change.number };
}
