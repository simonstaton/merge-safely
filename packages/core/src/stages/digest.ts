import type { Policy } from "../policy/schema.js";
import type { Finding, HumanDigest, ReviewerRun, Severity, Tier, Verdict } from "../types.js";

/** GitHub rejects check-run summaries over 65535 chars; stay well under. */
export const MAX_DIGEST_CHARS = 60_000;
const DEFAULT_MAX_PER_SEVERITY = 25;
const MAX_DETAIL_CHARS = 1_500;

export interface DigestOptions {
  maxFindingsPerSeverity?: number;
  policy?: Policy;
}

const GROUPS: Array<{ severity: Severity; label: string }> = [
  { severity: "blocker", label: "Blockers" },
  { severity: "important", label: "Important" },
  { severity: "nit", label: "Nits" },
  { severity: "pre-existing", label: "Pre-existing" },
];

/**
 * Text from models, policy patterns and PR metadata is rendered as data: HTML is escaped, markdown
 * emphasis, link and code characters are backslash-escaped (so a glob like `src/**` is not read as bold)
 * and @mentions are broken with a zero-width space so a finding cannot ping people or inject markup.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]|~]/g, (c) => `\\${c}`)
    .replace(/@(?=[A-Za-z0-9])/g, "@​");
}
const md = escapeMarkdown;

/** An inline code span. Markdown and HTML are inert inside it; only backticks need neutralising. */
const code = (s: string): string => `\`${s.replace(/`/g, "'").replace(/\r?\n/g, " ")}\``;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const shortSha = (sha: string): string => sha.slice(0, 7);
const shortId = (id: string): string => `#${id.slice(0, 6)}`;

function fmtUsd(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function wallMs(seats: ReviewerRun[]): number | undefined {
  const starts = seats.map((s) => Date.parse(s.startedAt)).filter(Number.isFinite);
  const ends = seats.map((s) => Date.parse(s.finishedAt)).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return undefined;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function location(f: Finding): string {
  if (!f.file) return "";
  return `${f.file}${f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}`;
}

export function verdictHeadline(verdict: Verdict, policy?: Policy): string {
  const decision = verdict.decision.toUpperCase();
  if (verdict.triaged) return `${decision} (tier ${verdict.tier.level}, triaged)`;
  const of = policy ? ` of ${policy.rounds.max}` : "";
  const kind = verdict.kind === "human" ? ", human" : "";
  return `${decision} (tier ${verdict.tier.level}, round ${verdict.round}${of}${kind})`;
}

interface Section {
  md: string[];
  text: string[];
}

function costLine(verdict: Verdict): Section {
  const parts: string[] = [];
  if (verdict.cost.usd !== undefined) parts.push(fmtUsd(verdict.cost.usd));
  parts.push(`${fmtTokens(verdict.cost.tokens.in)} tokens in / ${fmtTokens(verdict.cost.tokens.out)} out`);
  parts.push(plural(verdict.seats.length, "seat"));
  const ms = wallMs(verdict.seats);
  if (ms !== undefined) parts.push(fmtDuration(ms));
  const bySeat = Object.entries(verdict.cost.bySeat)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([seat, c]) => `${seat} → ${c.connectionId}/${c.model}${c.usd !== undefined ? ` ${fmtUsd(c.usd)}` : ""}`);
  const line = `Cost: ${parts.join(" · ")}`;
  return {
    md: [`**Cost:** ${md(parts.join(" · "))}`, ...(bySeat.length ? [`<sub>${md(bySeat.join("; "))}</sub>`] : [])],
    text: [line, ...(bySeat.length ? [`  Connections: ${bySeat.join("; ")}`] : [])],
  };
}

function findingsSection(findings: Finding[], maxPer: number): Section & { omitted: number } {
  const out: Section & { omitted: number } = { md: [], text: [], omitted: 0 };
  for (const { severity, label } of GROUPS) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    out.md.push("", `### ${label} (${group.length})`);
    out.text.push("", `${label} (${group.length})`);
    for (const f of group.slice(0, maxPer)) {
      const loc = location(f);
      out.md.push(
        `- **[${md(f.class)}] ${md(clip(f.title, 200))}**${loc ? ` — ${code(loc)}` : ""} <sub>${shortId(f.id)}</sub>`,
      );
      out.text.push(`  [${f.class}] ${clip(f.title, 200)}${loc ? ` — ${loc}` : ""} (${shortId(f.id)})`);
      const detail = clip(f.detail.trim(), MAX_DETAIL_CHARS);
      if (detail) {
        out.md.push(`  ${md(detail).replace(/\n/g, "\n  ")}`);
        out.text.push(`     ${detail.replace(/\n/g, "\n     ")}`);
      }
      if (f.evidence && f.evidence.length > 0) {
        const ev = f.evidence.map((e) => clip(e, 500));
        out.md.push(`  - Evidence: ${ev.map(md).join("; ")}`);
        out.text.push(`     Evidence: ${ev.join("; ")}`);
      }
      if (f.suggestedFix) {
        out.md.push(`  - Suggested: ${md(clip(f.suggestedFix, 800))}`);
        out.text.push(`     Suggested: ${clip(f.suggestedFix, 800)}`);
      }
    }
    if (group.length > maxPer) {
      const n = group.length - maxPer;
      out.omitted += n;
      out.md.push(`- _…and ${n} more ${label.toLowerCase()} not shown_`);
      out.text.push(`  …and ${n} more not shown`);
    }
  }
  return out;
}

function build(verdict: Verdict, maxPer: number, policy?: Policy): HumanDigest & { omitted: number } {
  const headline = verdictHeadline(verdict, policy);
  const m: string[] = [];
  const t: string[] = [];
  const meta = [`commit ${shortSha(verdict.headSha)}`];
  m.push(`## Merge Safely: ${headline}`, "", `<sub>${meta.join(" · ")}</sub>`, "");
  t.push(`Verdict: ${headline}`, meta.join(" · "));

  const why = verdict.tier.reasons.length > 0 ? verdict.tier.reasons.join("; ") : `score ${verdict.tier.score}`;
  m.push(`**Why tier ${verdict.tier.level}:** ${md(why)}`);
  t.push(`Why tier ${verdict.tier.level}: ${why}`);

  if (verdict.triaged) {
    const reason = verdict.triageReason ?? "deterministic triage";
    m.push("", `**Triaged:** ${md(reason)} — no reviewer seats were run.`);
    t.push(`Triaged: ${reason} — no reviewer seats were run.`);
  } else {
    const q = verdict.quorum;
    const quorum = `${q.required} required, ${q.passed} passed, ${q.blocked} blocked, ${q.invalid} invalid`;
    m.push("", `**Quorum:** ${quorum}`);
    t.push(`Quorum: ${quorum}`);
  }
  if (verdict.kind === "human" && verdict.signedBy) {
    const signed = `${verdict.signedBy.login}${verdict.reason ? `: ${verdict.reason}` : ""}`;
    m.push("", `**Signed by:** ${md(signed)}`);
    t.push(`Signed by: ${signed}`);
  }

  const fs = findingsSection(verdict.findings, maxPer);
  if (verdict.findings.length === 0 && !verdict.triaged) {
    m.push("", "No findings.");
    t.push("", "No findings.");
  }
  m.push(...fs.md);
  t.push(...fs.text);

  const tail: Section = { md: [], text: [] };
  const addressed = verdict.addressed ?? [];
  const carried = verdict.carried ?? [];
  if (addressed.length + carried.length > 0) {
    const since = Math.max(1, verdict.round - 1);
    const a = `Addressed since round ${since}: ${addressed.length} of ${addressed.length + carried.length} findings.`;
    const n = carried.length > 0 ? ` Not addressed: ${carried.map(shortId).join(", ")}.` : "";
    tail.md.push(`**${a}**${md(n)}`);
    tail.text.push(`${a}${n}`);
  }
  if (verdict.seats.length > 0) {
    const files = new Set(verdict.seats.flatMap((s) => s.audit.filesRead)).size;
    const commands = verdict.seats.reduce((n, s) => n + s.audit.commandsRun.length, 0);
    const insufficient = verdict.seats.filter((s) => s.status === "insufficient-work").length;
    const effort = `${plural(files, "file")} read, ${plural(commands, "command")}${
      insufficient > 0 ? `; ${plural(insufficient, "pass", "passes")} rejected for insufficient work` : ""
    }.`;
    tail.md.push(`**Reviewer effort:** ${effort}`);
    tail.text.push(`Reviewer effort: ${effort}`);
  }
  const downgrades = verdict.downgrades ?? [];
  if (downgrades.length > 0) {
    const d = downgrades
      .map((s) => `${s.step}${s.from || s.to ? ` (${s.from ?? "?"} → ${s.to ?? "?"})` : ""}: ${s.reason}`)
      .join("; ");
    tail.md.push(`**Downgrades applied:** ${md(d)}`);
    tail.text.push(`Downgrades applied: ${d}`);
  }
  const seatDowngrades = verdict.seats.filter((s) => s.seat.downgradedFrom);
  if (seatDowngrades.length > 0) {
    const d = seatDowngrades
      .map((s) => `${s.seat.id}: ${s.seat.downgradedFrom?.name ?? "?"} → ${s.seat.model.name}`)
      .join("; ");
    tail.md.push(`**Seats downgraded:** ${md(d)}`);
    tail.text.push(`Seats downgraded: ${d}`);
  }
  if (verdict.contested) {
    const c = "Contested: an unresolved block is stored for this commit, so this result could not overwrite it.";
    tail.md.push(`> ${c}`);
    tail.text.push(c);
  }
  if (verdict.escalated) {
    const e = "Escalated: a human reviewer has been asked to sign off on this commit.";
    tail.md.push(`> ${e}`);
    tail.text.push(e);
  }
  if (!policy || policy.reporting.showCostInSummary) {
    const c = costLine(verdict);
    tail.md.push(...c.md);
    tail.text.push(...c.text);
  }
  if (tail.md.length > 0) {
    m.push("", ...tail.md.flatMap((l, i) => (i === 0 ? [l] : ["", l])));
    t.push("", ...tail.text);
  }

  return { headline: `Verdict: ${headline}`, markdown: m.join("\n"), text: t.join("\n"), omitted: fs.omitted };
}

/**
 * Render the human digest for a verdict (design section 4.3): headline, why this tier, quorum, findings
 * grouped by severity, rounds progress, reviewer effort, downgrades, contested/escalated notes and cost.
 * Markdown is GitHub-flavoured and kept under MAX_DIGEST_CHARS by showing fewer findings per severity,
 * with a note saying how many were left out.
 */
export function renderDigest(verdict: Verdict, opts: DigestOptions = {}): HumanDigest {
  let maxPer = Math.max(1, opts.maxFindingsPerSeverity ?? DEFAULT_MAX_PER_SEVERITY);
  let out = build(verdict, maxPer, opts.policy);
  while (out.markdown.length > MAX_DIGEST_CHARS && maxPer > 1) {
    maxPer = Math.max(1, Math.floor(maxPer / 2));
    out = build(verdict, maxPer, opts.policy);
  }
  let { markdown, text } = out;
  if (markdown.length > MAX_DIGEST_CHARS) {
    const note = "\n\n_Digest truncated to fit the GitHub size limit; see the full verdict for every finding._";
    markdown = markdown.slice(0, MAX_DIGEST_CHARS - note.length) + note;
  } else if (out.omitted > 0) {
    markdown += `\n\n_${out.omitted} findings not shown to keep this summary readable; all are in the stored verdict._`;
  }
  if (text.length > MAX_DIGEST_CHARS) text = `${text.slice(0, MAX_DIGEST_CHARS - 20)}\n…(truncated)`;
  return { headline: out.headline, markdown, text };
}

/** Digest for a change the budget refused to review: what was hit and what to raise. */
export function renderBudgetBlockedDigest(args: {
  tier: Tier;
  ceiling: string;
  reason: string;
  estimateUsd?: number;
}): HumanDigest {
  const headline = `Verdict: BLOCKED BY BUDGET (tier ${args.tier.level})`;
  const est = args.estimateUsd !== undefined ? `Estimated panel cost: ${fmtUsd(args.estimateUsd)}.` : "";
  const fix = `To review this change, raise \`budget.${args.ceiling}\` in .merge-safely.yml or wait for the window to roll over.`;
  const why = args.tier.reasons.join("; ");
  const markdown = [
    `## Merge Safely: BLOCKED BY BUDGET (tier ${args.tier.level})`,
    `**Ceiling hit:** ${code(args.ceiling)}`,
    `**Reason:** ${md(args.reason)}`,
    ...(est ? [est] : []),
    ...(why ? [`**Why tier ${args.tier.level}:** ${md(why)}`] : []),
    fix,
  ].join("\n\n");
  const text = [
    headline,
    `Ceiling hit: ${args.ceiling}`,
    `Reason: ${args.reason}`,
    ...(est ? [est] : []),
    ...(why ? [`Why tier ${args.tier.level}: ${why}`] : []),
    fix.replace(/`/g, ""),
  ].join("\n");
  return { headline, markdown, text };
}

/** Digest shown while a review is in progress. */
export function renderPendingDigest(tier?: Tier): HumanDigest {
  const suffix = tier ? ` (tier ${tier.level})` : "";
  const headline = `Verdict: PENDING${suffix}`;
  const why = tier && tier.reasons.length > 0 ? tier.reasons.join("; ") : "";
  const body = "Review in progress. This check updates when the panel finishes.";
  const markdown = [
    `## Merge Safely: PENDING${suffix}`,
    "",
    body,
    ...(why ? ["", `**Why tier ${tier?.level}:** ${md(why)}`] : []),
  ].join("\n");
  const text = [headline, body, ...(why ? [`Why tier ${tier?.level}: ${why}`] : [])].join("\n");
  return { headline, markdown, text };
}
