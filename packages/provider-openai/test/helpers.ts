import type {
  Connection,
  ModelInfo,
  ReviewerInput,
  Seat,
  ToolCall,
  ToolExecutor,
  ToolExecutorFactory,
  WorkspaceHandle,
} from "@merge-safely/core";
import { REVIEWER_OUTPUT_JSON_SCHEMA } from "@merge-safely/core";
import { APIConnectionError, APIError } from "openai";

export const API_KEY = "sk-test-SUPERSECRETKEY-1234567890abcdef";

export function apiKeyConn(over: Partial<Connection> = {}): Connection {
  return {
    id: "conn-openai",
    provider: "openai",
    kind: "api-key",
    createdAt: "2026-01-01T00:00:00Z",
    secret: { kind: "api-key", apiKey: API_KEY },
    ...over,
  };
}

export function compatConn(over: Partial<Connection> = {}): Connection {
  return {
    id: "conn-compat",
    provider: "openai-compatible",
    kind: "openai-compatible",
    createdAt: "2026-01-01T00:00:00Z",
    secret: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKey: API_KEY },
    ...over,
  };
}

export const MODEL: ModelInfo = {
  provider: "openai",
  name: "gpt-5",
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 400_000,
  maxOutputTokens: 128_000,
  pricing: { inPerMTok: 1, outPerMTok: 10, cachedInPerMTok: 0.1 },
  tier: "frontier",
};

export function seat(over: Partial<Seat> = {}): Seat {
  return {
    id: "hunter:correctness:1",
    lens: "correctness",
    model: { connectionId: "conn-openai", provider: "openai", name: "gpt-5" },
    role: "hunter",
    budget: { maxTurns: 20, deadlineMs: 10_000 },
    ...over,
  };
}

export function input(over: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    change: {
      repo: { host: "github.com", owner: "o", name: "r" },
      number: 1,
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
    },
    tier: { level: 1, score: 10, factors: { loc: 1, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    diff: "diff --git a/x b/x",
    diffIsDelta: false,
    untrusted: { title: "t", body: "b" },
    knownFindings: [],
    allowedCommands: [],
    prompt: { system: "SYSTEM PROMPT", user: "USER PROMPT" },
    outputSchema: REVIEWER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    ...over,
  };
}

export const WS: WorkspaceHandle = { cwd: "/tmp/ws", headSha: "abc123", dispose: async () => undefined };

export const PASS = { verdict: "pass", summary: "looks fine", findings: [] };
export const BLOCK = {
  verdict: "block",
  summary: "bug",
  findings: [
    { severity: "blocker", class: "logic-error", title: "off by one", detail: "loop bound", file: "a.ts", line: 3 },
  ],
};

/** A fake read-only tool set that records calls and builds a real-looking audit. */
export function fakeTools(): { factory: ToolExecutorFactory; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const files: string[] = [];
  const factory: ToolExecutorFactory = () => {
    const ex: ToolExecutor = {
      definitions: () => [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          substantive: true,
        },
      ],
      execute: async (call) => {
        calls.push(call);
        const path = typeof call.input.path === "string" ? call.input.path : "";
        files.push(path);
        return { ok: true, output: `contents of ${path}`, filesRead: [path] };
      },
      audit: () => ({
        substantiveCalls: calls.length,
        totalCalls: calls.length,
        filesRead: [...files],
        commandsRun: [],
      }),
    };
    return ex;
  };
  return { factory, calls };
}

/** A real OpenAI SDK APIError subclass (RateLimitError, BadRequestError, ...) for the given status. */
export function apiError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  code?: string,
): APIError {
  return APIError.generate(status, { error: { message, ...(code ? { code } : {}) } }, message, new Headers(headers));
}

/** A real SDK connection error wrapping a Node/undici system error code. */
export function connError(code: string): APIConnectionError {
  return new APIConnectionError({ cause: Object.assign(new TypeError("fetch failed"), { cause: { code } }) });
}

/** A promise that only settles when the signal aborts (simulates a hung request). */
export function hang(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const e = new Error("Request was aborted.");
      e.name = "AbortError";
      reject(e);
    });
  });
}
