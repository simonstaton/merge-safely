import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { errorMessage, NETWORK_CODES, redact, systemErrorCode } from "./common/redact.js";
import { type ErrorClassifier, type ErrorInfo, NonRetryableError, parseRetryAfter } from "./common/retry.js";

function short(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Statuses worth retrying: request timeout, conflict, too early, rate limit and every 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Map an error thrown by the OpenAI SDK (or by fetch underneath it) to a safe, provider-neutral
 * ErrorInfo. Classification uses the SDK's error classes: they do not set `.name`, so name checks
 * would never match a real SDK error. Never includes the key.
 */
export function classifyOpenAIError(secrets: string[]): ErrorClassifier {
  return (err: unknown): ErrorInfo => {
    const msg = short(redact(errorMessage(err), secrets));
    if (err instanceof APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
      return { kind: "abort", retryable: false, message: "aborted" };
    }
    if (err instanceof APIConnectionTimeoutError) {
      return { kind: "network", retryable: true, message: "request timed out connecting to the provider" };
    }
    if (err instanceof APIConnectionError) {
      const sys = systemErrorCode(err);
      return { kind: "network", retryable: true, message: `network error${sys ? ` (${sys})` : ""}: ${msg}` };
    }
    if (err instanceof APIError && typeof err.status === "number") {
      const status = err.status;
      const h = err.headers;
      const retryAfterMs = parseRetryAfter(h?.get("retry-after"), h?.get("retry-after-ms"));
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
      if (status === 429 && err.code === "insufficient_quota")
        return {
          kind: "rate-limit",
          retryable: false,
          status,
          message: "quota exhausted (429 insufficient_quota): add credit or raise the provider limit",
        };
      if (status === 429)
        return { kind: "rate-limit", retryable: true, status, retryAfterMs, message: `rate limited (429): ${msg}` };
      if (isRetryableStatus(status))
        return { kind: "server", retryable: true, status, retryAfterMs, message: `provider error (${status}): ${msg}` };
      return { kind: "bad-request", retryable: false, status, message: `request rejected (${status}): ${msg}` };
    }
    // Not an SDK error (e.g. a raw fetch failure from a custom client): fall back to the system code.
    const sys = systemErrorCode(err);
    if (sys && NETWORK_CODES.has(sys))
      return { kind: "network", retryable: true, message: `network error (${sys}): ${msg}` };
    return { kind: "other", retryable: false, message: msg };
  };
}

/** True when a permanent 400/422 failure looks like the server rejecting strict function schemas. */
export function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof NonRetryableError)) return false;
  const { info } = err;
  if (info.kind !== "bad-request") return false;
  return /strict|schema|additionalProperties/i.test(info.message);
}
