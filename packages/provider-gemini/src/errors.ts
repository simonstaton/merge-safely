import { errorMessage, NETWORK_CODES, redact, systemErrorCode } from "./common/redact.js";
import type { ErrorClassifier, ErrorInfo } from "./common/retry.js";

function short(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** google.rpc.RetryInfo surfaces in the error body as `"retryDelay": "17s"` (or "1.5s"). */
export function retryDelayFromMessage(message: string): number | undefined {
  const m = message.match(/"?retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m?.[1] ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Map a `@google/genai` ApiError (or fetch failure) to a safe, provider-neutral ErrorInfo. */
export function classifyGeminiError(secrets: string[]): ErrorClassifier {
  return (err: unknown): ErrorInfo => {
    const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
    if (rec.name === "AbortError") return { kind: "abort", retryable: false, message: "aborted" };
    const status = typeof rec.status === "number" ? rec.status : undefined;
    const raw = redact(errorMessage(err), secrets);
    const msg = short(raw);
    if (status !== undefined) {
      if (status === 401 || (status === 400 && /API[_ ]KEY[_ ]INVALID|API key not valid/i.test(raw)))
        return {
          kind: "auth",
          retryable: false,
          status,
          message: `authentication failed (${status}): the API key was rejected`,
        };
      if (status === 403)
        return { kind: "permission", retryable: false, status, message: `permission denied (403): ${msg}` };
      if (status === 404) return { kind: "not-found", retryable: false, status, message: `not found (404): ${msg}` };
      if (status === 429)
        return {
          kind: "rate-limit",
          retryable: true,
          status,
          retryAfterMs: retryDelayFromMessage(raw),
          message: `rate limited (429): ${msg}`,
        };
      if (status === 408 || status >= 500)
        return {
          kind: "server",
          retryable: true,
          status,
          retryAfterMs: retryDelayFromMessage(raw),
          message: `provider error (${status}): ${msg}`,
        };
      return { kind: "bad-request", retryable: false, status, message: `request rejected (${status}): ${msg}` };
    }
    const sys = systemErrorCode(err);
    if ((sys && NETWORK_CODES.has(sys)) || (err instanceof TypeError && /fetch failed/i.test(raw))) {
      return { kind: "network", retryable: true, message: `network error${sys ? ` (${sys})` : ""}: ${msg}` };
    }
    return { kind: "other", retryable: false, message: msg };
  };
}
