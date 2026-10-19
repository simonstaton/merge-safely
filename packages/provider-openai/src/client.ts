import type { Connection } from "@merge-safely/core";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions";
import type { ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";

/** Minimal Responses API result shape the runner reads. The real SDK `Response` is a superset. */
export interface ResponsesResult {
  output: ResponseOutputItem[];
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

/** Minimal Chat Completions result shape the runner reads. The real SDK `ChatCompletion` is a superset. */
export interface ChatResult {
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      tool_calls?: ChatCompletionMessageToolCall[] | null;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

export interface RequestOpts {
  signal?: AbortSignal;
}

/** The subset of the OpenAI SDK this package uses. Inject a fake via `clientFactory` in tests. */
export interface OpenAILike {
  models: { list(): Promise<{ data: Array<{ id: string; owned_by?: string }> }> };
  responses: { create(body: ResponseCreateParamsNonStreaming, opts?: RequestOpts): Promise<ResponsesResult> };
  chat: {
    completions: { create(body: ChatCompletionCreateParamsNonStreaming, opts?: RequestOpts): Promise<ChatResult> };
  };
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Placeholder key for keyless openai-compatible endpoints (Ollama, LM Studio, vLLM). It must be set
 * explicitly: otherwise the SDK falls back to OPENAI_API_KEY from the environment and would send the
 * user's real OpenAI key to a third-party base URL.
 */
export const KEYLESS_PLACEHOLDER = "not-needed";

export interface ClientConfig {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
}

/** Resolve SDK client config from a connection. Throws on a secret kind this provider cannot use. */
export function clientConfig(conn: Connection): ClientConfig {
  const s = conn.secret;
  switch (s.kind) {
    case "api-key":
      return { apiKey: s.apiKey, baseURL: OPENAI_BASE_URL };
    case "oauth":
      return { apiKey: s.accessToken, baseURL: OPENAI_BASE_URL };
    case "openai-compatible":
      return {
        apiKey: s.apiKey || KEYLESS_PLACEHOLDER,
        baseURL: s.baseUrl.replace(/\/+$/, ""),
        defaultHeaders: s.headers,
      };
    default:
      throw new Error(`connection kind "${s.kind}" is not supported by the openai provider`);
  }
}

/** Real SDK client. SDK retries are disabled: the runner owns retries so it can honour budgets. */
export function defaultClientFactory(conn: Connection): OpenAILike {
  const cfg = clientConfig(conn);
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    defaultHeaders: cfg.defaultHeaders,
    maxRetries: 0,
    // Never pick up org/project from the environment for a third-party base URL.
    organization: null,
    project: null,
  });
  return {
    models: {
      list: async () => {
        const page = await client.models.list();
        return { data: page.data.map((m) => ({ id: m.id, owned_by: m.owned_by })) };
      },
    },
    responses: { create: (body, opts) => client.responses.create(body, opts) },
    chat: { completions: { create: (body, opts) => client.chat.completions.create(body, opts) } },
  };
}
