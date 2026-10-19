import type { Connection } from "@merge-safely/core";

/** Every secret string carried by a connection, so error text can be scrubbed of them. */
export function secretValues(conn: Connection): string[] {
  const s = conn.secret;
  const out: string[] = [];
  switch (s.kind) {
    case "api-key":
      out.push(s.apiKey);
      break;
    case "anthropic-compatible":
    case "openai-compatible":
      if (s.apiKey) out.push(s.apiKey);
      for (const v of Object.values(s.headers ?? {})) out.push(v);
      break;
    case "oauth":
      out.push(s.accessToken);
      if (s.refreshToken) out.push(s.refreshToken);
      break;
    default:
      break;
  }
  // Very short values would redact ordinary words; real credentials are long.
  return out.filter((v) => typeof v === "string" && v.length >= 8);
}

const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(x-api-key|authorization|api[_-]?key|auth[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

/** Remove known secret values and anything shaped like a credential. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const v of secrets) {
    if (v) out = out.split(v).join("[redacted]");
  }
  out = out.replace(SECRET_SHAPES[0] as RegExp, "[redacted]");
  out = out.replace(SECRET_SHAPES[1] as RegExp, "$1 [redacted]");
  out = out.replace(SECRET_SHAPES[2] as RegExp, "$1$2[redacted]");
  return out;
}
