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

export function apiKeyOf(conn: Connection): string {
  if (conn.secret.kind !== "api-key") {
    throw new Error(`connection kind "${conn.secret.kind}" is not supported by the gemini provider (use api-key)`);
  }
  return conn.secret.apiKey;
}

/**
 * Real SDK client against the Gemini Developer API. `vertexai: false` is explicit so an ambient
 * GOOGLE_GENAI_USE_VERTEXAI cannot silently reroute the call. No `retryOptions`: the SDK then does not
 * retry, and the runner owns retries so it can honour budgets and deadlines.
 */
export function defaultClientFactory(conn: Connection): GenAILike {
  const ai = new GoogleGenAI({ apiKey: apiKeyOf(conn), vertexai: false });
  return {
    models: {
      list: () => ai.models.list({ config: { pageSize: 100 } }),
      generateContent: (params) => ai.models.generateContent(params),
    },
  };
}
