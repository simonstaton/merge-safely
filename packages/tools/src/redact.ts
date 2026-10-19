export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // PEM blocks (also a BEGIN with its END cut off by truncation).
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Authorization header values, to end of line.
  [/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, (_m, k: string) => `${k}${REDACTED}`],
  // password=/token= style assignments with a quoted literal, or an unspaced KEY=value (env/ini/URL query).
  [
    /(\b[A-Za-z0-9_]*(?:password|passwd|token|secret|api_?key)\s*[:=]\s*)(["'])[^"'\r\n]{4,}\2/gi,
    (_m, k: string, q: string) => `${k}${q}${REDACTED}${q}`,
  ],
  [
    /(\b[A-Za-z0-9_]*(?:password|passwd|token|secret|api_?key)=)(?!["'])[^\s&"'`]{4,}/gi,
    (_m, k: string) => `${k}${REDACTED}`,
  ],
];

/**
 * Replace secret-shaped strings in tool output with [REDACTED] so they never reach a prompt
 * (and from there a finding posted on the PR). Shapes: OpenAI/Anthropic keys, GitHub tokens,
 * AWS access key ids, Slack tokens, PEM blocks, Authorization header values and
 * password/token/secret/api_key assignments.
 *
 * TODO: switch to `redactSecrets` from @merge-safely/core once it is exported.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) {
    out =
      typeof rep === "string" ? out.replace(re, rep) : out.replace(re, rep as (m: string, ...g: string[]) => string);
  }
  return out;
}
