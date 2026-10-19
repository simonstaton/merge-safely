import type { Change, Finding, HumanDigest, ReviewerRun, Verdict } from "@merge-safely/core";

export const repo = { host: "github.com", owner: "acme", name: "widgets" };

export function change(overrides: Partial<Change> = {}): Change {
  return {
    repo,
    number: 7,
    headSha: "head1",
    baseSha: "base1",
    baseRef: "main",
    headRef: "feature",
    title: "Add widget",
    body: "",
    author: { kind: "human", login: "alice" },
    files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    stats: { additions: 1, deletions: 0, files: 1 },
    labels: [],
    draft: false,
    ciStatus: "success",
    url: "https://github.com/acme/widgets/pull/7",
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "blocker",
    class: "lock-risk",
    title: "Unbatched backfill",
    detail: "Scans the whole table in one transaction.",
    file: "src/a.ts",
    line: 2,
    ...overrides,
  };
}

export function seatRun(overrides: Partial<ReviewerRun> = {}): ReviewerRun {
  return {
    seat: {
      id: "hunter:correctness:1",
      lens: "correctness",
      model: { connectionId: "c", provider: "anthropic", name: "m" },
      role: "hunter",
      budget: { maxTurns: 10, deadlineMs: 1000 },
    },
    headSha: "head1",
    round: 1,
    output: { verdict: "block", summary: "s", findings: [finding()] },
    audit: {
      substantiveCalls: 3,
      totalCalls: 5,
      filesRead: Array.from({ length: 40 }, (_, i) => `file${i}.ts`),
      commandsRun: ["npm test"],
      tokens: { in: 100, out: 50 },
      wallMs: 1000,
      turns: 4,
    },
    status: "ok",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

export function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    repo,
    number: 7,
    headSha: "head1",
    kind: "machine",
    decision: "block",
    tier: { level: 2, score: 55, factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    triaged: false,
    seats: [seatRun()],
    findings: [finding()],
    quorum: { required: 2, passed: 1, blocked: 1, invalid: 0 },
    cost: { usd: 1.5, tokens: { in: 100, out: 50 }, bySeat: {} },
    downgrades: [{ step: "hunters-model", from: "a", to: "b", reason: "budget" }],
    addressed: ["f0"],
    carried: ["f1"],
    createdAt: "2026-01-01T00:02:00Z",
    policyHash: "abc123",
    ...overrides,
  };
}

export function digest(overrides: Partial<HumanDigest> = {}): HumanDigest {
  return {
    headline: "Verdict: BLOCK (tier 2, round 1)",
    markdown: "## Blockers\n- thing",
    text: "BLOCK",
    ...overrides,
  };
}
