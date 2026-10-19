/**
 * Block Kit builders. Everything that comes from a PR or from model output is untrusted: it is escaped
 * so it cannot inject Slack mentions (`<!channel>`), links or user pings, and it is length-limited to
 * stay within Block Kit limits.
 */
import type { Finding, HumanDigest, RepoRef, ReportEvent, Verdict } from "@merge-safely/core";

/** Slack mrkdwn control characters. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function prUrl(repo: RepoRef, number: number, explicit?: string): string {
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
  return `https://${repo.host}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pull/${number}`;
}

export function prLabel(repo: RepoRef, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`;
}

/** `<url|label>` with the label escaped; the url comes from repo coordinates, not free text. */
export function link(url: string, label: string): string {
  return `<${url.replace(/[<>|]/g, "")}|${escapeMrkdwn(label)}>`;
}

export const MAX_BLOCKERS = 5;

function findingLine(f: Finding): string {
  const where = f.file ? ` \`${escapeMrkdwn(truncate(f.file, 120))}${f.line ? `:${f.line}` : ""}\`` : "";
  return `• *${escapeMrkdwn(truncate(f.title, 200))}*${where} _(${escapeMrkdwn(truncate(f.class, 40))})_`;
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

export function verdictCommand(v: Verdict): string {
  return `merge-safely verdict --repo ${v.repo.owner}/${v.repo.name} --pr ${v.number} --sha ${v.headSha} --pass|--block`;
}

/** The escalation message: headline, tier, quorum, top blockers, PR link and how to resolve. */
export function escalationMessage(v: Verdict, digest: HumanDigest, opts: { channelHint?: string } = {}): SlackMessage {
  const url = prUrl(v.repo, v.number);
  const label = prLabel(v.repo, v.number);
  const blockers = v.findings.filter((f) => f.severity === "blocker");
  const top = blockers.slice(0, MAX_BLOCKERS);
  const q = v.quorum;
  const headline = truncate(digest.headline || `Review needed for ${label}`, 150);

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headline, emoji: false } },
    {
      type: "section",
      fields: [
        mrkdwn(`*Pull request*\n${link(url, label)}`),
        mrkdwn(`*Tier*\n${v.tier.level} (score ${Math.round(v.tier.score)})`),
        mrkdwn(`*Machine decision*\n${v.decision}${v.contested ? " (contested)" : ""}`),
        mrkdwn(`*Quorum*\n${q.passed} pass / ${q.blocked} block / ${q.invalid} invalid (need ${q.required})`),
        mrkdwn(`*Head SHA*\n\`${escapeMrkdwn(v.headSha.slice(0, 12))}\``),
        mrkdwn(`*Round*\n${v.round}`),
      ],
    },
  ];
  if (top.length) {
    const more = blockers.length > top.length ? `\n_…and ${blockers.length - top.length} more_` : "";
    blocks.push({
      type: "section",
      text: mrkdwn(truncate(`*Top blockers*\n${top.map(findingLine).join("\n")}${more}`, 2900)),
    });
  } else {
    blocks.push({ type: "section", text: mrkdwn("*Top blockers*\nNone confirmed; escalated by policy.") });
  }
  blocks.push({
    type: "section",
    text: mrkdwn(`*To resolve*, post a human verdict bound to this SHA:\n\`${escapeMrkdwn(verdictCommand(v))}\``),
  });
  const context = [`merge-safely escalation`, `policy ${escapeMrkdwn(v.policyHash.slice(0, 12))}`];
  if (opts.channelHint) context.push(`for ${escapeMrkdwn(truncate(opts.channelHint, 80))}`);
  blocks.push({ type: "context", elements: [mrkdwn(context.join(" · "))] });

  return { text: escapeMrkdwn(`Escalation: ${headline} (${label}, tier ${v.tier.level})`), blocks };
}

const ICON: Record<string, string> = { pass: ":white_check_mark:", block: ":no_entry:", pending: ":hourglass:" };

/** Short one-section messages for the reporter. */
export function reportMessage(event: Exclude<ReportEvent, { type: "pending" }>): SlackMessage {
  const c = event.change;
  const label = prLabel(c.repo, c.number);
  const pr = link(prUrl(c.repo, c.number, c.url), label);
  let line: string;
  switch (event.type) {
    case "verdict": {
      const v = event.verdict;
      const blockers = v.findings.filter((f) => f.severity === "blocker").length;
      line = `${ICON[v.decision] ?? ""} *${v.decision.toUpperCase()}* ${pr} · tier ${v.tier.level} · ${v.quorum.passed}/${v.quorum.required} passed${
        blockers ? ` · ${blockers} blocker${blockers === 1 ? "" : "s"}` : ""
      }${v.triaged ? " · triaged" : ""}\n${escapeMrkdwn(truncate(event.digest.headline, 300))}`;
      break;
    }
    case "escalated":
      line = `:rotating_light: *ESCALATED* ${pr} · tier ${event.verdict.tier.level} · needs a human verdict\n${escapeMrkdwn(
        truncate(event.digest.headline, 300),
      )}`;
      break;
    case "budget-blocked":
      line = `:money_with_wings: *BUDGET BLOCKED* ${pr} · tier ${event.tier.level} · ceiling ${escapeMrkdwn(
        truncate(event.ceiling, 80),
      )}\n${escapeMrkdwn(truncate(event.reason, 500))}`;
      break;
    case "error":
      line = `:warning: *ERROR* ${pr} · round ${event.round}\n${escapeMrkdwn(truncate(event.error, 500))}`;
      break;
  }
  const text = truncate(line, 2900);
  return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
}
