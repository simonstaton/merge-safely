import type { Connection } from "@merge-safely/core";

export const REDACTED = "[REDACTED]";

/** Every secret string carried by a connection, so output and error text can be scrubbed of them. */
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
      out.push(...urlCredentials(s.baseUrl));
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

/** User and password embedded in a URL (https://user:pass@host). */
function urlCredentials(url: string): string[] {
  try {
    const u = new URL(url);
    return [decodeURIComponent(u.username), decodeURIComponent(u.password)].filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PAT)S?$|(^|_)(KEY|TOKEN|SECRET|AUTH)_/i;

/** Values of credential-looking variables in an environment (e.g. the gate's own process.env). */
export function envSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.length >= 8 && SECRET_ENV_NAME.test(k)) out.push(v);
  }
  return out;
}

/** Shapes that are credentials wherever they appear. Order matters: most specific first. */
const SHAPES: { re: RegExp; to: string }[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, to: REDACTED },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, to: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, to: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: REDACTED },
  { re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, to: REDACTED },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: `$1 ${REDACTED}` },
  {
    re: /(x-api-key|authorization|api[_-]?key|auth[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
    to: `$1$2${REDACTED}`,
  },
  { re: /(\/\/)[^/\s:@]+:[^/\s@]+@/g, to: `$1${REDACTED}@` },
];

/** Remove known secret values and anything shaped like a credential. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Longest first so a value containing another is removed whole.
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) {
    if (v) out = out.split(v).join(REDACTED);
  }
  for (const { re, to } of SHAPES) out = out.replace(re, to);
  return out;
}

/** Deep-scrub every string in a JSON-shaped value. */
export function scrubDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return scrub(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, secrets);
    return out as T;
  }
  return value;
}
