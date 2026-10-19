import type { Policy } from "../policy/schema.js";
import type { Change, ChangedFile, TicketRef, UntrustedText } from "../types.js";

/**
 * Intake: normalise the change and quarantine every piece of author-controlled text into `UntrustedText`.
 * When `policy.runner.redactSecrets` is on, secret shapes are redacted from the untrusted text, from the
 * change's title/body and from per-file patches, so nothing downstream (prompts, logs, verdicts) sees them.
 */

interface Rule {
  kind: string;
  re: RegExp;
  /** Return the replacement for a match, or null to leave it untouched (false-positive guard). */
  replace: (match: string, groups: string[]) => string | null;
}

const tag = (kind: string) => `[REDACTED:${kind}]`;
const whole =
  (kind: string) =>
  (_m: string): string =>
    tag(kind);

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlaceholder(v: string): boolean {
  return (
    v.length === 0 ||
    v.startsWith("${") ||
    v.startsWith("{{") ||
    v.startsWith("<") ||
    v.startsWith("%") ||
    v.startsWith("process.env") ||
    v.includes("[REDACTED:") ||
    /^(.)\1*$/.test(v) ||
    /^(changeme|example|placeholder|redacted|dummy|test|null|undefined|none|true|false)$/i.test(v)
  );
}

/** Unquoted assignment values must look like a literal secret, not code (`getToken()`, `process.env.X`). */
function looksLikeUnquotedSecret(v: string): boolean {
  return v.length >= 8 && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/[()[\]]/.test(v) && !isPlaceholder(v);
}

function looksLikeHighEntropy(v: string): boolean {
  if (v.length < 20 || UUID_RE.test(v) || isPlaceholder(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length;
  const hex = /^[0-9a-fA-F]+$/.test(v);
  if (hex) return v.length >= 32 && /[0-9]/.test(v) && /[a-fA-F]/.test(v);
  return classes >= 3 && entropy(v) >= 3.5;
}

// Generic assignment name: identifier ending in a credential word, optionally quoted (JSON/YAML keys).
const GENERIC_NAME = String.raw`(?<![A-Za-z0-9_.\-])(["']?)([A-Za-z0-9_.\-]*?(?:password|passwd|secret|token|api[_-]?key)s?)\1`;
// Key-like names for the high-entropy rule.
const KEYLIKE_NAME = String.raw`(?<![A-Za-z0-9_.\-])(["']?)([A-Za-z0-9_.\-]*?(?:key|secret|token|auth|credentials?|creds?|salt|signature|dsn))\1`;
const ASSIGN = String.raw`(\s*(?:=>|:=|[:=])\s*)`;

const RULES: Rule[] = [
  {
    kind: "private-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
    replace: whole("private-key"),
  },
  {
    // A truncated PEM block (no END line in view): redact the header and the base64 body lines after it.
    kind: "private-key",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\r?\n[+\- ]?[A-Za-z0-9+/=]{16,})*/g,
    replace: whole("private-key"),
  },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole("aws-access-key") },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, replace: whole("github-token") },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, replace: whole("github-token") },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: whole("anthropic-key") },
  {
    kind: "openai-key",
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    // Require a digit and a letter so kebab-case identifiers like `sk-button-container-large` survive.
    replace: (m) => (/[0-9]/.test(m.slice(3)) && /[A-Za-z]/.test(m.slice(3)) ? tag("openai-key") : null),
  },
  { kind: "slack-token", re: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g, replace: whole("slack-token") },
  {
    kind: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
    replace: whole("slack-webhook"),
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: whole("jwt"),
  },
  {
    // password = "hunter22", "api_key": 'abc123...', token: `...`
    kind: "credential",
    re: new RegExp(`${GENERIC_NAME}${ASSIGN}(["'\`])([^"'\`\\n]*)\\4`, "gi"),
    replace: (m, g) => {
      const value = g[4] ?? "";
      if (value.length < 6 || /\s/.test(value) || isPlaceholder(value)) return null;
      return m.slice(0, m.length - value.length - 1) + tag("credential") + (g[3] ?? "");
    },
  },
  {
    // password=hunter2abc (unquoted, env files, YAML)
    kind: "credential",
    re: new RegExp(`${GENERIC_NAME}${ASSIGN}([^\\s,;'"\`]+)`, "gi"),
    replace: (m, g) => {
      const value = g[3] ?? "";
      if (!looksLikeUnquotedSecret(value)) return null;
      return m.slice(0, m.length - value.length) + tag("credential");
    },
  },
  {
    // STRIPE_KEY=4eC39HqLyjWDarjtT1zdp7dc, signing_key: "...": long, mixed, high-entropy values after key names.
    kind: "high-entropy",
    re: new RegExp(`${KEYLIKE_NAME}${ASSIGN}(["'\`]?)([A-Za-z0-9+/=_\\-.~]{20,})\\4`, "gi"),
    replace: (m, g) => {
      const value = g[4] ?? "";
      if (!looksLikeHighEntropy(value)) return null;
      const closing = g[3] ?? "";
      return m.slice(0, m.length - value.length - closing.length) + tag("high-entropy") + closing;
    },
  },
];

/** Redact secret-shaped substrings. Returns the redacted text and how many substrings were replaced. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      // rest = [...groups, offset, input, namedGroups?]; keep only the capture groups.
      const groups: string[] = [];
      for (const r of rest) {
        if (typeof r === "number") break;
        groups.push(typeof r === "string" ? r : "");
      }
      const replaced = rule.replace(match, groups);
      if (replaced === null) return match;
      redactions++;
      return replaced;
    });
  }
  return { text: out, redactions };
}

/** Redact a unified diff when the policy asks for it; otherwise return it unchanged. */
export function redactDiff(diff: string, policy: Policy): string {
  return policy.runner.redactSecrets ? redactSecrets(diff).text : diff;
}

export interface IntakeContext {
  commitMessages?: string[];
  comments?: string[];
}

export interface IntakeResult {
  change: Change;
  untrusted: UntrustedText;
  /** Total secret-shaped substrings redacted across untrusted text and patches. */
  redactions: number;
}

function normalisePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/^\/+/, "");
}

/**
 * Normalise a change and quarantine untrusted text.
 * - File paths are normalised (`./x` -> `x`) and duplicate entries for the same path are merged.
 * - `stats.files` is never less than the number of listed files.
 * - Title, body, commit messages, comments and ticket text are copied into `untrusted`, redacted when
 *   `policy.runner.redactSecrets` is on; the returned change carries the same redacted title/body/patches.
 */
export function intake(change: Change, ctx: IntakeContext, policy: Policy): IntakeResult {
  const redact = policy.runner.redactSecrets;
  let redactions = 0;
  const clean = (s: string): string => {
    if (!redact) return s;
    const r = redactSecrets(s);
    redactions += r.redactions;
    return r.text;
  };

  const byPath = new Map<string, ChangedFile>();
  for (const f of change.files) {
    const path = normalisePath(f.path);
    const file: ChangedFile = { ...f, path };
    if (f.previousPath !== undefined) file.previousPath = normalisePath(f.previousPath);
    if (f.patch !== undefined) file.patch = clean(f.patch);
    const prior = byPath.get(path);
    if (prior) {
      prior.additions += file.additions;
      prior.deletions += file.deletions;
      if (file.patch !== undefined) prior.patch = prior.patch ? `${prior.patch}\n${file.patch}` : file.patch;
    } else {
      byPath.set(path, file);
    }
  }
  const files = [...byPath.values()];

  const title = clean(change.title);
  const body = clean(change.body);
  let ticket: TicketRef | undefined;
  if (change.linkedTicket) {
    ticket = { ...change.linkedTicket };
    if (ticket.title !== undefined) ticket.title = clean(ticket.title);
    if (ticket.body !== undefined) ticket.body = clean(ticket.body);
  }

  const untrusted: UntrustedText = { title, body };
  if (ctx.commitMessages) untrusted.commitMessages = ctx.commitMessages.map(clean);
  if (ctx.comments) untrusted.comments = ctx.comments.map(clean);
  if (ticket) untrusted.ticket = ticket;

  const normalised: Change = {
    ...change,
    title,
    body,
    files,
    stats: { ...change.stats, files: Math.max(change.stats.files, files.length) },
  };
  if (ticket) normalised.linkedTicket = ticket;

  return { change: normalised, untrusted, redactions };
}
