/**
 * Block Kit builders.
 *
 * Everything from a PR or from model output is untrusted. It is sanitised BEFORE any mrkdwn is built:
 * - inline fields (titles, paths, classes, hints): control characters including CR/LF become spaces, backticks are
 *   removed, whitespace is collapsed, length is capped, then `& < >` are escaped. This stops forged lines, code-span
 *   breakouts and `<!channel>` / `<@U…>` / `<url|label>` injection.
 * - multi-line text (error strings, budget reasons): put inside a ``` block with backticks removed and escaped.
 * Slack may still auto-link a bare URL that appears in untrusted inline text; links are not prevented.
 */
import type { Finding, HumanDigest, RepoRef, ReportEvent, Verdict } from "@merge-safely/core";

/** Escape Slack mrkdwn control characters. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truncate by code points (never splits a surrogate pair), adding an ellipsis. */
export function truncate(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// C0 and C1 controls, DEL, and the Unicode line/paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Single-line plain text (no escaping): for plain_text blocks such as the header. */
export function plainInline(text: string, max: number): string {
  return truncate(text.replace(CONTROL, " ").replace(/`/g, "").replace(/\s+/g, " ").trim(), max);
}

/** Single-line untrusted text, safe to drop into mrkdwn. */
export function inline(text: string, max: number): string {
  return escapeMrkdwn(plainInline(text, max));
}

/** Multi-line untrusted text as a mrkdwn code block. */
export function codeBlock(text: string, max: number, maxLines = 20): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_EXCEPT_NEWLINE, " ")
    .replace(/`/g, "")
    .split("\n")
    .slice(0, maxLines)
    .join("\n")
    .trim();
  const body = escapeMrkdwn(truncate(lines, max));
  return `\`\`\`${body || " "}\`\`\``;
}

export function prUrl(repo: RepoRef, number: number, explicit?: string): string {
  if (explicit && /^https?:\/\/[^\s<>|]+$/i.test(explicit)) return explicit;
  return `https://${encodeURIComponent(repo.host)}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pull/${number}`;
}

export function prLabel(repo: RepoRef, number: number): string {
  return `${plainInline(repo.owner, 100)}/${plainInline(repo.name, 100)}#${number}`;
}

/** `<url|label>`; the url has `<>|` and whitespace removed, the label is escaped. */
export function link(url: string, label: string): string {
  return `<${url.replace(/[<>|\s]/g, "")}|${escapeMrkdwn(label)}>`;
}

export const MAX_BLOCKERS = 5;

function findingLine(f: Finding): string {
  const file = f.file ? plainInline(f.file, 120) : "";
  const line = f.line && Number.isInteger(f.line) && f.line > 0 ? `:${f.line}` : "";
  const where = file ? ` \`${escapeMrkdwn(file)}${line}\`` : "";
  return `• *${inline(f.title, 200)}*${where} _(${inline(f.class, 40)})_`;
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });

/** Default instruction for resolving an escalation with a SHA-bound human verdict. */
export function defaultResolveHint(v: Verdict): string {
  return `merge-safely verdict --repo ${plainInline(v.repo.owner, 100)}/${plainInline(v.repo.name, 100)} --pr ${v.number} --sha ${plainInline(v.headSha, 64)} --decision pass|block --reason "…"`;
}

export type ResolveHint = string | ((v: Verdict) => string);

export interface EscalationMessageOptions {
  channelHint?: string;
  /** Replaces the default `merge-safely verdict …` instruction. Rendered as a code span. */
  resolveHint?: ResolveHint;
}

/** The escalation message: headline, tier, quorum, top blockers, PR link and how to resolve. */
export function escalationMessage(v: Verdict, digest: HumanDigest, opts: EscalationMessageOptions = {}): SlackMessage {
  const url = prUrl(v.repo, v.number);
  const label = prLabel(v.repo, v.number);
  const blockers = v.findings.filter((f) => f.severity === "blocker");
  const top = blockers.slice(0, MAX_BLOCKERS);
  const q = v.quorum;
  const headline = plainInline(digest.headline || `Review needed for ${label}`, 150) || `Review needed for ${label}`;

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headline, emoji: false } },
    {
      type: "section",
      fields: [
        mrkdwn(`*Pull request*\n${link(url, label)}`),
        mrkdwn(`*Tier*\n${v.tier.level} (score ${Math.round(v.tier.score)})`),
        mrkdwn(`*Machine decision*\n${inline(v.decision, 20)}${v.contested ? " (contested)" : ""}`),
        mrkdwn(`*Quorum*\n${q.passed} pass / ${q.blocked} block / ${q.invalid} invalid (need ${q.required})`),
        mrkdwn(`*Head SHA*\n\`${inline(v.headSha, 64).slice(0, 12)}\``),
        mrkdwn(`*Round*\n${v.round}`),
      ],
    },
  ];
  if (top.length) {
    const more = blockers.length > top.length ? `\n_…and ${blockers.length - top.length} more_` : "";
    blocks.push({ type: "section", text: mrkdwn(`*Top blockers*\n${top.map(findingLine).join("\n")}${more}`) });
  } else {
    blocks.push({ type: "section", text: mrkdwn("*Top blockers*\nNone confirmed; escalated by policy.") });
  }
  const hint =
    opts.resolveHint === undefined
      ? defaultResolveHint(v)
      : typeof opts.resolveHint === "function"
        ? opts.resolveHint(v)
        : opts.resolveHint;
  blocks.push({
    type: "section",
    text: mrkdwn(`*To resolve*, record a human verdict bound to this SHA:\n\`${inline(hint, 600)}\``),
  });
  const context = ["merge-safely escalation", `policy ${inline(v.policyHash, 64).slice(0, 12)}`];
  if (opts.channelHint) context.push(`for ${inline(opts.channelHint, 80)}`);
  blocks.push({ type: "context", elements: [mrkdwn(context.join(" · "))] });

  return { text: `Escalation: ${inline(headline, 150)} (${escapeMrkdwn(label)}, tier ${v.tier.level})`, blocks };
}

const ICON: Record<string, string> = { pass: ":white_check_mark:", block: ":no_entry:", pending: ":hourglass:" };

/** Short one-section messages for the reporter. */
export function reportMessage(event: Exclude<ReportEvent, { type: "pending" }>): SlackMessage {
  const c = event.change;
  const label = prLabel(c.repo, c.number);
  const pr = link(prUrl(c.repo, c.number, c.url), label);
  let text: string;
  switch (event.type) {
    case "verdict": {
      const v = event.verdict;
      const blockers = v.findings.filter((f) => f.severity === "blocker").length;
      text = `${ICON[v.decision] ?? ""} *${inline(v.decision.toUpperCase(), 20)}* ${pr} · tier ${v.tier.level} · ${v.quorum.passed}/${v.quorum.required} passed${
        blockers ? ` · ${blockers} blocker${blockers === 1 ? "" : "s"}` : ""
      }${v.triaged ? " · triaged" : ""}\n${inline(event.digest.headline, 300)}`;
      break;
    }
    case "escalated":
      text = `:rotating_light: *ESCALATED* ${pr} · tier ${event.verdict.tier.level} · needs a human verdict\n${inline(event.digest.headline, 300)}`;
      break;
    case "budget-blocked":
      text = `:money_with_wings: *BUDGET BLOCKED* ${pr} · tier ${event.tier.level} · ceiling ${inline(event.ceiling, 80)}\n${codeBlock(event.reason, 1000)}`;
      break;
    case "error":
      text = `:warning: *ERROR* ${pr} · round ${event.round}\n${codeBlock(event.error, 1500)}`;
      break;
  }
  return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
}
