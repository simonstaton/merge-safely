import Anthropic from "@anthropic-ai/sdk";
import type { Connection } from "@merge-safely/core";
import type { RuntimeModel } from "./models.js";

/** The slice of the Anthropic SDK this package uses. Tests inject a fake through `clientFactory`. */
export interface AnthropicLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      opts?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
  models: {
    list(opts?: { signal?: AbortSignal }): Promise<{ data: RuntimeModel[] }>;
  };
}

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Build an SDK client for an API-shaped connection. Base URL and credentials are always explicit so the
 * SDK never falls back to ANTHROPIC_* variables in the gate's own environment. SDK retries are off: the
 * runner retries itself so it can respect the seat deadline.
 */
export function createAnthropicClient(conn: Connection, fetchImpl?: typeof fetch): AnthropicLike {
  const s = conn.secret;
  const optBase = typeof conn.options?.baseUrl === "string" ? conn.options.baseUrl : undefined;
  let opts: ConstructorParameters<typeof Anthropic>[0];
  switch (s.kind) {
    case "api-key":
      opts = { apiKey: s.apiKey, authToken: null, baseURL: optBase ?? DEFAULT_BASE_URL };
      break;
    case "anthropic-compatible":
      opts = { apiKey: s.apiKey, authToken: null, baseURL: s.baseUrl, defaultHeaders: { ...(s.headers ?? {}) } };
      break;
    case "oauth":
      opts = {
        apiKey: null,
        authToken: s.accessToken,
        baseURL: optBase ?? DEFAULT_BASE_URL,
        defaultHeaders: { "anthropic-beta": OAUTH_BETA },
      };
      break;
    default:
      throw new Error(`anthropic: connection kind "${s.kind}" has no Messages API client`);
  }
  const client = new Anthropic({ ...opts, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return {
    messages: {
      create: (body, o) => client.messages.create(body, o),
    },
    models: {
      list: async (o) => {
        const page = await client.models.list({ limit: 100 }, o);
        return { data: page.data as RuntimeModel[] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Error mapping (never echoes credentials)
// ---------------------------------------------------------------------------

export interface ApiErrorInfo {
  status?: number;
  retryable: boolean;
  /** Milliseconds requested by retry-after / retry-after-ms, when present. */
  retryAfterMs?: number;
  aborted: boolean;
  /** Safe, scrubbable summary. */
  message: string;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as { get?: unknown };
  if (typeof h.get === "function") {
    const v = (h.get as (n: string) => unknown).call(headers, name);
    return typeof v === "string" ? v : undefined;
  }
  const rec = headers as Record<string, unknown>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return typeof v === "string" ? v : undefined;
}

export function parseRetryAfter(headers: unknown): number | undefined {
  const ms = headerValue(headers, "retry-after-ms");
  if (ms !== undefined && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headerValue(headers, "retry-after");
  if (ra === undefined) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err && typeof err === "object" && "name" in err) {
    const n = (err as { name: unknown }).name;
    return n === "AbortError" || n === "APIUserAbortError";
  }
  return false;
}

/** Classify an SDK (or fetch) error. Message text is a fixed phrase per status, plus a scrubbed API detail for 4xx. */
export function describeApiError(err: unknown): ApiErrorInfo {
  if (isAbortError(err)) return { retryable: false, aborted: true, message: "request aborted" };
  const status =
    err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  const headers =
    err && typeof err === "object" && "headers" in err ? (err as { headers: unknown }).headers : undefined;
  const retryAfterMs = parseRetryAfter(headers);
  if (status === undefined) {
    // APIConnectionError, timeouts, DNS, TLS, fetch TypeError.
    return { retryable: true, aborted: false, message: "anthropic API unreachable (network error)" };
  }
  const base = { status, aborted: false, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 401)
    return { ...base, retryable: false, message: "anthropic API rejected the credentials (401 invalid key)" };
  if (status === 403) return { ...base, retryable: false, message: "anthropic API denied access (403 permission)" };
  if (status === 404) return { ...base, retryable: false, message: "anthropic API: model or endpoint not found (404)" };
  if (status === 429) return { ...base, retryable: true, message: "anthropic API rate limited (429)" };
  if (status === 529) return { ...base, retryable: true, message: "anthropic API overloaded (529)" };
  if (status >= 500) return { ...base, retryable: true, message: `anthropic API server error (${status})` };
  if (status === 408 || status === 409)
    return { ...base, retryable: true, message: `anthropic API transient error (${status})` };
  return { ...base, retryable: false, message: `anthropic API request failed (${status}): ${apiDetail(err)}` };
}

/** The API's own error.message for a 4xx, truncated. Callers still run it through scrub(). */
function apiDetail(err: unknown): string {
  const body = err && typeof err === "object" && "error" in err ? (err as { error: unknown }).error : undefined;
  const inner =
    body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : (body as unknown);
  const msg =
    inner &&
    typeof inner === "object" &&
    "message" in inner &&
    typeof (inner as { message: unknown }).message === "string"
      ? (inner as { message: string }).message
      : "bad request";
  return msg.slice(0, 300);
}
