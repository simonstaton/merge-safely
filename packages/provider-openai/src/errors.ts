import { errorMessage, NETWORK_CODES, redact, systemErrorCode } from "./common/redact.js";
import { type ErrorClassifier, type ErrorInfo, NonRetryableError, parseRetryAfter } from "./common/retry.js";

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const v: unknown = get.call(headers, name);
    return typeof v === "string" ? v : undefined;
  }
  const v = (headers as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
}

function field(err: unknown, key: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
}

function short(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Map an OpenAI SDK (or fetch) error to a safe, provider-neutral ErrorInfo. Duck-typed so fakes and
 * other OpenAI-compatible clients classify the same way. Never includes the key.
 */
export function classifyOpenAIError(secrets: string[]): ErrorClassifier {
  return (err: unknown): ErrorInfo => {
    const name = field(err, "name");
    if (name === "AbortError" || name === "APIUserAbortError")
      return { kind: "abort", retryable: false, message: "aborted" };
    const statusRaw = field(err, "status");
    const status = typeof statusRaw === "number" ? statusRaw : undefined;
    const msg = short(redact(errorMessage(err), secrets));
    if (status !== undefined) {
      const headers = field(err, "headers");
      const retryAfterMs = parseRetryAfter(header(headers, "retry-after"), header(headers, "retry-after-ms"));
      const code = field(err, "code");
      if (status === 401)
        return {
          kind: "auth",
          retryable: false,
          status,
          message: "authentication failed (401): the API key or token was rejected",
        };
      if (status === 403)
        return { kind: "permission", retryable: false, status, message: `permission denied (403): ${msg}` };
      if (status === 404) return { kind: "not-found", retryable: false, status, message: `not found (404): ${msg}` };
      if (status === 429 && code === "insufficient_quota")
        return {
          kind: "rate-limit",
          retryable: false,
          status,
          message: "quota exhausted (429 insufficient_quota): add credit or raise the provider limit",
        };
      if (status === 429)
        return { kind: "rate-limit", retryable: true, status, retryAfterMs, message: `rate limited (429): ${msg}` };
      if (status === 408 || status === 409 || status >= 500)
        return { kind: "server", retryable: true, status, retryAfterMs, message: `provider error (${status}): ${msg}` };
      return { kind: "bad-request", retryable: false, status, message: `request rejected (${status}): ${msg}` };
    }
    const sys = systemErrorCode(err);
    if ((sys && NETWORK_CODES.has(sys)) || name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
      return { kind: "network", retryable: true, message: `network error${sys ? ` (${sys})` : ""}: ${msg}` };
    }
    return { kind: "other", retryable: false, message: msg };
  };
}

/** True when a permanent 400/422 failure looks like the server rejecting strict function schemas. */
export function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof NonRetryableError)) return false;
  const { info } = err;
  if (info.kind !== "bad-request") return false;
  return /strict|schema|additionalProperties|json_schema|parameters/i.test(info.message);
}
