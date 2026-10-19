import { redactText } from "@merge-safely/core";

export const REDACTED = "[REDACTED]";

/**
 * Replace secret-shaped strings with [REDACTED] so they never reach a prompt (and from there a finding
 * posted on the PR) or an error message. Delegates to core's redactor in aggressive mode, which covers
 * provider/GitHub/cloud/chat key shapes, PEM blocks, Authorization header values, query-string and
 * password/token/secret/api_key assignments.
 */
export function redactSecrets(text: string): string {
  return redactText(text, { aggressive: true, replacement: REDACTED });
}

/**
 * Replace known secret values (connection keys, tokens, header values) verbatim, longest first so a value
 * containing another is removed whole, then redact secret shapes. Values shorter than `minLength` are
 * skipped: they would redact ordinary words.
 */
export function redactWithSecrets(
  text: string,
  secrets: ReadonlyArray<string | undefined> = [],
  minLength = 4,
): string {
  return redactSecrets(replaceLiterals(text, secrets, REDACTED, minLength));
}

/** Replace every occurrence of each literal value (longest first) with `replacement`, or with its result. */
export function replaceLiterals(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
  replacement: string | ((secret: string) => string),
  minLength = 1,
): string {
  let out = text;
  const values = secrets.filter((s): s is string => typeof s === "string" && s.length >= minLength);
  for (const s of [...values].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(typeof replacement === "string" ? replacement : replacement(s));
  }
  return out;
}
