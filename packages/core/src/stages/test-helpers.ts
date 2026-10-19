/**
 * Fixture builders for tests. Pure and dependency-free so any package can reuse them in its own tests:
 * `import { makeChange, makeRun } from "@merge-safely/core"`.
 */
import { loadPolicy } from "../policy/index.js";
import type { Policy, PolicyInput } from "../policy/schema.js";
import type {
  Change,
  ChangedFile,
  Finding,
  JudgeOutput,
  ReviewerOutput,
  ReviewerRun,
  Seat,
  SeatRole,
  Tier,
  ToolUseAudit,
  Verdict,
} from "../types.js";

/** A parsed policy with overrides applied on top of the defaults. */
export function makePolicy(overrides: PolicyInput = {}): Policy {
  return loadPolicy(overrides);
}

export function makeFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", additions: 1, deletions: 0, ...overrides };
}

/**
 * A change with sensible defaults. `files` may be paths or full ChangedFile objects; `stats` is derived
 * from the files unless given explicitly.
 */
export function makeChange(
  overrides: Omit<Partial<Change>, "files"> & { files?: Array<string | ChangedFile> } = {},
): Change {
  const { files: rawFiles, ...rest } = overrides;
  const files = (rawFiles ?? ["src/index.ts"]).map((f) => (typeof f === "string" ? makeFile(f) : f));
  const stats = {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files: files.length,
  };
  return {
    repo: { host: "github.com", owner: "acme", name: "widgets" },
    number: 42,
    headSha: "1111111111111111111111111111111111111111",
    baseSha: "0000000000000000000000000000000000000000",
    baseRef: "main",
    headRef: "feature",
    title: "Add a widget",
    body: "This adds a widget.",
    author: { kind: "human", login: "octocat" },
    files,
    stats,
    labels: [],
    draft: false,
    ciStatus: "success",
    ...rest,
  };
}

export function makeAudit(overrides: Partial<ToolUseAudit> = {}): ToolUseAudit {
  return {
    substantiveCalls: 5,
    totalCalls: 6,
    filesRead: ["src/index.ts"],
    commandsRun: [],
    tokens: { in: 1000, out: 200 },
    wallMs: 1000,
    turns: 3,
    ...overrides,
  };
}

export function makeSeat(overrides: Partial<Seat> & { role?: SeatRole } = {}): Seat {
  const role = overrides.role ?? "hunter";
  const lens = overrides.lens ?? "correctness";
  return {
    id: `${role}:${lens}:1`,
    lens,
    role,
    model: { connectionId: "conn-main", provider: "anthropic", name: "model-a" },
    budget: { maxTurns: 50, deadlineMs: 600_000 },
    ...overrides,
  };
}

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "",
    severity: "important",
    class: "logic-error",
    title: "Off by one in loop bound",
    detail: "The loop reads one element past the end of the array.",
    file: "src/index.ts",
    line: 10,
    ...overrides,
  };
}

/** A hunter run. Pass `output: null` for a failed run. */
export function makeRun(
  overrides: Omit<Partial<ReviewerRun>, "output"> & {
    output?: Partial<ReviewerOutput> | null;
    lens?: string;
    seatId?: string;
  } = {},
): ReviewerRun {
  const { output, lens, seatId, seat, ...rest } = overrides;
  const builtSeat = seat ?? makeSeat({ role: "hunter", ...(lens ? { lens } : {}), ...(seatId ? { id: seatId } : {}) });
  return {
    seat: builtSeat,
    headSha: "1111111111111111111111111111111111111111",
    round: 1,
    output: output === null ? null : { verdict: "pass", summary: "Looks fine.", findings: [], ...(output ?? {}) },
    audit: makeAudit(),
    status: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    ...rest,
  };
}

/** A judge run. Pass `judgeOutput: null` for a failed run. */
export function makeJudgeRun(
  overrides: Omit<Partial<ReviewerRun>, "judgeOutput"> & {
    judgeOutput?: Partial<JudgeOutput> | null;
    seatId?: string;
  } = {},
): ReviewerRun {
  const { judgeOutput, seatId, seat, ...rest } = overrides;
  const builtSeat = seat ?? makeSeat({ role: "judge", lens: "judge", ...(seatId ? { id: seatId } : {}) });
  return {
    seat: builtSeat,
    headSha: "1111111111111111111111111111111111111111",
    round: 1,
    output: null,
    judgeOutput: judgeOutput === null ? null : { votes: [], ...(judgeOutput ?? {}) },
    audit: makeAudit(),
    status: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    ...rest,
  };
}

export function makeTier(overrides: Partial<Tier> = {}): Tier {
  return {
    level: 1,
    score: 30,
    factors: { loc: 100, files: 3, modules: 1, criticalPathHits: [], ...(overrides.factors ?? {}) },
    reasons: ["size: 100 LOC across 3 files in 1 module"],
    ...overrides,
  };
}

export function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    repo: { host: "github.com", owner: "acme", name: "widgets" },
    number: 42,
    headSha: "1111111111111111111111111111111111111111",
    kind: "machine",
    decision: "pass",
    tier: makeTier(),
    round: 1,
    triaged: false,
    seats: [],
    findings: [],
    quorum: { required: 1, passed: 1, blocked: 0, invalid: 0 },
    cost: { tokens: { in: 0, out: 0 }, bySeat: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    policyHash: "0123456789abcdef",
    ...overrides,
  };
}
