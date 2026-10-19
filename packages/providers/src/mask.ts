import { type ConnectionSecret, redactText } from "@merge-safely/core";

/**
 * Mask a secret for display: `…k3Fd` (last four characters) when the secret is long enough that the tail
 * reveals nothing useful, otherwise a fixed `****`.
 */
export function maskSecret(s: string): string {
  if (s.length < 12) return "****";
  return `…${s.slice(-4)}`;
}

/** Query parameter names whose values are credentials (`api-key`, `token`, `sig`, ...); `api-version` is not. */
const CREDENTIAL_QUERY_KEY = /key|token|secret|auth|sig|password|passwd|credential/i;

/**
 * Userinfo and credential-looking query-string values embedded in a URL (e.g. `https://u:pw@gw/v1?api-key=…`),
 * raw and decoded. Other query values (`api-version=2024-10-21`) are configuration, not secrets.
 */
export function urlCredentials(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch (_err: unknown) {
    return [];
  }
  const out = new Set<string>();
  const add = (raw: string) => {
    if (!raw) return;
    out.add(raw);
    try {
      out.add(decodeURIComponent(raw));
    } catch (_err: unknown) {
      // keep the raw form only
    }
  };
  add(u.username);
  add(u.password);
  for (const [k, v] of u.searchParams) {
    if (!CREDENTIAL_QUERY_KEY.test(k)) continue;
    out.add(v);
    add(encodeURIComponent(v));
  }
  return [...out].filter((v) => v !== "");
}

/** The secret strings inside a connection secret (keys, tokens, header values). */
export function secretValues(secret: ConnectionSecret | undefined): string[] {
  if (!secret) return [];
  const out: string[] = [];
  switch (secret.kind) {
    case "api-key":
      out.push(secret.apiKey);
      break;
    case "openai-compatible":
    case "anthropic-compatible":
      if (secret.apiKey) out.push(secret.apiKey);
      out.push(...urlCredentials(secret.baseUrl));
      for (const v of Object.values(secret.headers ?? {})) out.push(v);
      break;
    case "oauth":
      out.push(secret.accessToken);
      if (secret.refreshToken) out.push(secret.refreshToken);
      break;
    case "cloud":
    case "subscription":
      break;
  }
  // Very short values (e.g. a header "1") would over-redact ordinary text; they are not meaningful secrets.
  return out.filter((v) => v.length >= 6);
}

/**
 * Replace every occurrence of the given secret values in `text` with their masked form (longest first),
 * then redact anything else shaped like a credential with core's redactor.
 */
export function scrubText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join(maskSecret(s));
  }
  return redactText(out, { aggressive: true, replacement: "[REDACTED]" });
}
