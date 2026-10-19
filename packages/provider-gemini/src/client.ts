import { type Content, type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import type { Connection } from "@merge-safely/core";

/** Minimal model-list entry. The SDK `Model` is a superset. */
export interface GeminiModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
}

/** Minimal generateContent result the runner reads. The SDK `GenerateContentResponse` is a superset. */
export interface GeminiResult {
  candidates?: Array<{ content?: Content; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/** The subset of `@google/genai` this package uses. Inject a fake via `clientFactory` in tests. */
export interface GenAILike {
  models: {
    list(): Promise<AsyncIterable<GeminiModel>>;
    generateContent(params: GenerateContentParameters): Promise<GeminiResult>;
  };
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";

export function apiKeyOf(conn: Connection): string {
  if (conn.secret.kind !== "api-key") {
    throw new Error(`connection kind "${conn.secret.kind}" is not supported by the gemini provider (use api-key)`);
  }
  // An empty key must not reach the SDK, which would then fall back to GOOGLE_API_KEY / GEMINI_API_KEY.
  if (!conn.secret.apiKey) throw new Error("connection has an empty API key");
  return conn.secret.apiKey;
}

/**
 * Real SDK client against the Gemini Developer API. Everything the SDK would otherwise take from the
 * environment is pinned: `apiKey` (GOOGLE_API_KEY / GEMINI_API_KEY), `vertexai: false`
 * (GOOGLE_GENAI_USE_VERTEXAI, so GOOGLE_APPLICATION_CREDENTIALS is never used), and an explicit
 * `httpOptions.baseUrl`, without which GOOGLE_GEMINI_BASE_URL would send the key and the PR to another
 * host. No `retryOptions`: the SDK then does not retry, and the runner owns retries so it can honour
 * budgets and deadlines.
 */
export function defaultClientFactory(conn: Connection): GenAILike {
  const ai = new GoogleGenAI({
    apiKey: apiKeyOf(conn),
    vertexai: false,
    apiVersion: GEMINI_API_VERSION,
    httpOptions: { baseUrl: GEMINI_BASE_URL, apiVersion: GEMINI_API_VERSION },
  });
  return {
    models: {
      list: () => ai.models.list({ config: { pageSize: 100 } }),
      generateContent: (params) => ai.models.generateContent(params),
    },
  };
}
