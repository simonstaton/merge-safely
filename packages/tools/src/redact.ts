import { redactText } from "@merge-safely/core";

export const REDACTED = "[REDACTED]";

/**
 * Redaction for content a reviewer reads: tool output (read_file, search, git_*, run_command) and findings.
 * Known secret values are replaced verbatim first (longest first), then core's DEFAULT, precise redactor
 * removes real credential shapes (provider/GitHub/AWS/Slack keys, PEM private keys, JWTs, Bearer tokens,
 * literal password/token assignments). Code that merely handles credentials (`apiKey: string`,
 * `const token = getToken()`) is left exactly as written so reviewers can review it.
 */
export function redactToolOutput(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  return redactText(replaceLiterals(text, secrets, REDACTED, 4), { replacement: REDACTED });
}

/**
 * Redaction for diagnostics leaving the process: error messages, logs, check-run error text. Known secret
 * values first, then core's redactor in aggressive mode (also Authorization/api-key header values, short
 * key shapes, query-string credentials, any PEM block). Never use it on code or findings.
 */
export function redactDiagnostics(
  text: string,
  secrets: ReadonlyArray<string | undefined> = [],
  minLength = 4,
): string {
  return redactText(replaceLiterals(text, secrets, REDACTED, minLength), { aggressive: true, replacement: REDACTED });
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
  for (const s of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(typeof replacement === "string" ? replacement : replacement(s));
  }
  return out;
}
