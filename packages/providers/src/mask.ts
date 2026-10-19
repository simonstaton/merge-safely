import type { ConnectionSecret } from "@merge-safely/core";

/**
 * Mask a secret for display: `…k3Fd` (last four characters) when the secret is long enough that the tail
 * reveals nothing useful, otherwise a fixed `****`.
 */
export function maskSecret(s: string): string {
  if (s.length < 12) return "****";
  return `…${s.slice(-4)}`;
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

/** Replace every occurrence of the given secret values in `text` with their masked form. */
export function scrubText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join(maskSecret(s));
  }
  return out;
}
