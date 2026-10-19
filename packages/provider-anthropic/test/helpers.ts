import type Anthropic from "@anthropic-ai/sdk";
import type {
  Change,
  Connection,
  ModelInfo,
  ReviewerInput,
  Seat,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  WorkspaceHandle,
} from "@merge-safely/core";
import { REVIEWER_OUTPUT_JSON_SCHEMA } from "@merge-safely/core";
import type { AnthropicLike } from "../src/client.js";
import type { RuntimeModel } from "../src/models.js";

export const API_KEY = "sk-ant-api03-TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789";

export function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: "anthropic-main",
    provider: "anthropic",
    kind: "api-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    secret: { kind: "api-key", apiKey: API_KEY },
    ...over,
  };
}

export function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "anthropic",
    name: "claude-sonnet-5-5",
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    tier: "mid",
    pricing: { inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    ...over,
  };
}

export function seat(over: Partial<Seat> = {}, budget: Partial<Seat["budget"]> = {}): Seat {
  return {
    id: "hunter:correctness:1",
    lens: "correctness",
    model: { connectionId: "anthropic-main", provider: "anthropic", name: "claude-sonnet-5-5" },
    role: "hunter",
    budget: { maxTurns: 10, deadlineMs: 10_000, ...budget },
    ...over,
  };
}

export function input(over: Partial<ReviewerInput> = {}): ReviewerInput {
  const change = {
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
  } satisfies Change;
  return {
    change,
    tier: { level: 1, score: 10, factors: { loc: 1, files: 1, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    diff: "diff --git a/x b/x",
    diffIsDelta: false,
    untrusted: { title: "t", body: "b" },
    knownFindings: [],
    allowedCommands: ["npm test"],
    prompt: { system: "You are the correctness lens.", user: "Review this diff." },
    outputSchema: REVIEWER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    ...over,
  };
}

export function ws(cwd = "/workspace"): WorkspaceHandle {
  return { cwd, headSha: "abc123", dispose: async () => {} };
}

export const PASS_OUTPUT = { verdict: "pass", summary: "Looks fine.", findings: [] };

/** A fake read-only executor that records calls and builds its own audit. */
export class FakeExecutor implements ToolExecutor {
  calls: ToolCall[] = [];
  private files = new Set<string>();
  constructor(readonly opts?: { allowedCommands?: string[] }) {}
  definitions(): ToolDefinition[] {
    return [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        substantive: true,
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const path = String(call.input.path ?? "");
    this.files.add(path);
    return { ok: true, output: `contents of ${path}`, filesRead: [path] };
  }
  audit() {
    return {
      substantiveCalls: this.calls.length,
      totalCalls: this.calls.length,
      filesRead: [...this.files],
      commandsRun: [],
    };
  }
}

type Step =
  | Anthropic.Message
  | Error
  | ((body: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal) => Promise<Anthropic.Message>);

/** A scripted client: each messages.create call consumes the next step. */
export class FakeClient implements AnthropicLike {
  bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(
    private readonly steps: Step[],
    private readonly modelList: RuntimeModel[] | Error = [],
  ) {}
  messages = {
    create: async (body: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }) => {
      this.bodies.push(structuredClone(body));
      const step = this.steps.shift();
      if (!step) throw new Error("fake client: no more scripted responses");
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(body, opts?.signal);
      return step;
    },
  };
  models = {
    list: async () => {
      if (this.modelList instanceof Error) throw this.modelList;
      return { data: this.modelList };
    },
  };
}

let n = 0;
export function message(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.StopReason,
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: null,
      service_tier: "standard",
      ...usage,
    },
  };
}

export function toolUse(name: string, input: unknown, id = `toolu_${++n}`): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

export function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}
