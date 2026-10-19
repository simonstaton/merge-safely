/**
 * Secret redaction for anything that may leave the runner (errors, logs, run.error).
 * Known secrets are replaced verbatim; common key shapes are masked as a second line of defence.
 */

const KEY_SHAPES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g, // OpenAI / OpenRouter / many gateways
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi,
];

export function redact(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  for (const re of KEY_SHAPES) {
    out = out.replace(re, (_m: string, prefix: unknown) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

/** Collect every string secret held by a connection secret blob (keys, tokens, header values). */
export function secretStrings(secret: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 3) return;
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  if (secret && typeof secret === "object") {
    const rec = secret as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      // kind and baseUrl are not secret; everything else (keys, tokens, headers) is treated as secret.
      if (k === "kind" || k === "baseUrl" || k === "region" || k === "projectOrResource") continue;
      walk(v, 0);
    }
  }
  return out.filter((s) => s.length >= 4);
}

/** Message of an unknown thrown value, without stack traces. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown error";
}

/** Walk an error's cause chain looking for a Node or undici error code (ENOTFOUND, EAI_AGAIN, UND_ERR_SOCKET, ...). */
export function systemErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^(E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);
