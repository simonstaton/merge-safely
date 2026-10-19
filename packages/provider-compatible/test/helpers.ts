import type { Change, Connection, ModelInfo, ReviewerInput, Seat, WorkspaceHandle } from "@merge-safely/core";
import { REVIEWER_OUTPUT_JSON_SCHEMA } from "@merge-safely/core";

export function conn(over: Partial<Connection> & Pick<Connection, "secret">): Connection {
  return {
    id: "conn-1",
    provider: "openai-compatible",
    kind: over.secret.kind,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

export function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "anthropic",
    name: "claude-sonnet-5-5",
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    tier: "mid",
    pricing: { inPerMTok: 3, outPerMTok: 15 },
    ...over,
  };
}

export function seat(over: Partial<Seat> = {}): Seat {
  return {
    id: "hunter:correctness:1",
    lens: "correctness",
    model: { connectionId: "conn-1", provider: "anthropic", name: "claude-sonnet-5-5" },
    role: "hunter",
    budget: { maxTurns: 4, deadlineMs: 10_000 },
    ...over,
  };
}

export function input(): ReviewerInput {
  const change: Change = {
    repo: { host: "github.com", owner: "acme", name: "app" },
    number: 7,
    headSha: "abc123",
    baseSha: "def456",
    baseRef: "main",
    headRef: "feat",
    title: "t",
    body: "b",
    author: { kind: "human", login: "dev" },
    files: [],
    stats: { additions: 1, deletions: 0, files: 1 },
    labels: [],
    draft: false,
    ciStatus: "success",
  };
  return {
    change,
    tier: { level: 1, score: 10, factors: { loc: 1, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    diff: "diff --git a/x b/x",
    diffIsDelta: false,
    untrusted: { title: "t", body: "b" },
    knownFindings: [],
    allowedCommands: [],
    prompt: { system: "You are the correctness lens.", user: "Review this diff." },
    outputSchema: REVIEWER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
}

export function ws(): WorkspaceHandle {
  return { cwd: "/workspace", headSha: "abc123", dispose: async () => {} };
}

export const PASS = { verdict: "pass", summary: "Looks fine.", findings: [] };
