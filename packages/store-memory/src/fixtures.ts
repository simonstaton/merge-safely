import type { CostEntry, RepoRef, Verdict } from "@merge-safely/core";

export const FIXTURE_REPO: RepoRef = { host: "github.com", owner: "acme", name: "widgets" };

/** A minimal valid Verdict for store tests. */
export function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    repo: FIXTURE_REPO,
    number: 1,
    headSha: "a".repeat(40),
    kind: "machine",
    decision: "pass",
    tier: { level: 1, score: 10, factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    triaged: false,
    seats: [],
    findings: [],
    quorum: { required: 1, passed: 1, blocked: 0, invalid: 0 },
    cost: { usd: 0, tokens: { in: 0, out: 0 }, bySeat: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    policyHash: "policy-hash",
    ...overrides,
  };
}

/** A minimal CostEntry for ledger tests. */
export function makeCostEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    at: "2026-01-01T00:00:00.000Z",
    repo: FIXTURE_REPO,
    number: 1,
    headSha: "a".repeat(40),
    round: 1,
    seatId: "seat-1",
    lens: "correctness",
    connectionId: "conn-1",
    provider: "anthropic",
    model: "model-x",
    tokens: { in: 0, out: 0 },
    usd: 0,
    estimated: false,
    installationId: "inst-1",
    ...overrides,
  };
}

/** A settable clock for window tests. */
export function fakeClock(start: string | Date = "2026-01-10T00:00:00.000Z"): {
  now: () => Date;
  set: (t: string | Date) => void;
  advance: (ms: number) => void;
} {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (t) => {
      current = new Date(t).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
