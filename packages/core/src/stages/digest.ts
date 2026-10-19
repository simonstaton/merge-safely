import type { Policy } from "../policy/schema.js";
import type { Finding, HumanDigest, ReviewerRun, Severity, Tier, Verdict } from "../types.js";
import { redactText } from "./intake.js";

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

// ---------------------------------------------------------------------------
// Untrusted text rendering. Everything a model, a PR author or a policy file wrote goes through one of
// three functions: `inline` (one markdown line), `quote` (a markdown blockquote) or `plain` (text digest).
// All three redact secret shapes first: reviewers read the workspace and can quote real secrets.
// ---------------------------------------------------------------------------

const ZWSP = "​";

/**
 * Escape markdown/HTML so text is rendered as data: HTML is escaped, emphasis/link/code characters are
 * backslash-escaped (a glob like `src/**` is not read as bold), autolinks are broken, and @mentions get a
 * zero-width space so a finding cannot ping people.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]|~]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, `:/${ZWSP}/`)
    .replace(/\bwww\./gi, (w) => `${w.slice(0, 3)}${ZWSP}.`)
    .replace(/@(?=[A-Za-z0-9])/g, `@${ZWSP}`);
}

/** Escape block-level markers at the start of a line (headings, quotes, lists, setext/thematic rules). */
function escapeLineStart(line: string): string {
  const trimmed = line.replace(/^[ \t]+/, "");
  return trimmed.replace(/^(#|>|-|\+|=|\d+[.)])/, (m) => `\\${m}`);
}

/** One line of markdown: newlines collapsed, leading block markers neutralised, escaped, redacted. */
function inline(s: string, max = 200): string {
  const collapsed = clip(redactText(s).replace(/\s+/g, " ").trim(), max);
  return escapeLineStart(escapeMarkdown(collapsed));
}

/**
 * A markdown blockquote: every line is prefixed `> `, escaped, and has leading block markers escaped, so
 * nothing inside can open a heading, list, table, fence or rule, or end the quote.
 */
function quote(s: string, max: number): string[] {
  const text = clip(redactText(s).trim(), max);
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => {
    const l = escapeLineStart(escapeMarkdown(line));
    return l.trim() === "" ? ">" : `> ${l}`;
  });
}

/** Plain text for the text digest (also posted to chat tools): redacted and de-pinged. */
function plain(s: string, max = Number.POSITIVE_INFINITY, oneLine = false): string {
  let out = clip(redactText(s), max);
  if (oneLine) out = out.replace(/\s+/g, " ").trim();
  return out.replace(/<([!@#])/g, `<${ZWSP}$1`).replace(/@(?=[A-Za-z0-9])/g, `@${ZWSP}`);
}

/** An inline code span. Markdown and HTML are inert inside it; only backticks and newlines need neutralising. */
const code = (s: string): string => `\`${redactText(s).replace(/`/g, "'").replace(/\s+/g, " ")}\``;

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  // Never split a surrogate pair.
  let cut = n - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${s.slice(0, cut)}…`;
}

/** Truncate at a line boundary so no tag, entity or code span is cut in half. */
function truncateAtLine(s: string, max: number, note: string): string {
  if (s.length <= max) return s;
  const budget = max - note.length;
  const cut = s.lastIndexOf("\n", budget);
  return `${s.slice(0, cut > 0 ? cut : 0)}${note}`;
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
  return {
    md: [
      `**Cost:** ${inline(parts.join(" · "), 500)}`,
      ...(bySeat.length ? [`<sub>${inline(bySeat.join("; "), 4000)}</sub>`] : []),
    ],
    text: [
      `Cost: ${plain(parts.join(" · "), 500, true)}`,
      ...(bySeat.length ? [`  Connections: ${plain(bySeat.join("; "), 4000, true)}`] : []),
    ],
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
        "",
        `**[${inline(f.class, 64)}] ${inline(f.title)}**${loc ? ` — ${code(loc)}` : ""} <sub>${shortId(f.id)}</sub>`,
      );
      out.text.push(
        `  [${plain(f.class, 64, true)}] ${plain(f.title, 200, true)}${loc ? ` — ${plain(loc)}` : ""} (${shortId(f.id)})`,
      );
      const body: string[] = [...quote(f.detail, MAX_DETAIL_CHARS)];
      const detail = plain(f.detail.trim(), MAX_DETAIL_CHARS);
      if (detail) out.text.push(`     ${detail.replace(/\n/g, "\n     ")}`);
      for (const e of f.evidence ?? []) {
        if (body.length > 0) body.push(">");
        const lines = quote(e, 500);
        if (lines[0]) lines[0] = lines[0].replace(/^> ?/, "> **Evidence:** ");
        body.push(...lines);
        out.text.push(`     Evidence: ${plain(e, 500, true)}`);
      }
      if (f.suggestedFix) {
        if (body.length > 0) body.push(">");
        const lines = quote(f.suggestedFix, 800);
        if (lines[0]) lines[0] = lines[0].replace(/^> ?/, "> **Suggested:** ");
        body.push(...lines);
        out.text.push(`     Suggested: ${plain(f.suggestedFix, 800, true)}`);
      }
      if (body.length > 0) out.md.push("", ...body);
    }
    if (group.length > maxPer) {
      const n = group.length - maxPer;
      out.omitted += n;
      out.md.push("", `_…and ${n} more ${label.toLowerCase()} not shown_`);
      out.text.push(`  …and ${n} more not shown`);
    }
  }
  return out;
}

/** Seats whose result did not count, with their status, so an outage reads as an outage. */
function seatProblems(seats: ReviewerRun[]): Section {
  const bad = seats.filter((s) => s.status !== "ok");
  if (bad.length === 0) return { md: [], text: [] };
  const items = bad.map((s) => `${s.seat.id || s.seat.lens} (${s.status}${s.error ? `: ${s.error}` : ""})`);
  return {
    md: [`**Seats not counted (${bad.length}):** ${items.map((i) => inline(i, 300)).join("; ")}`],
    text: [`Seats not counted (${bad.length}): ${items.map((i) => plain(i, 300, true)).join("; ")}`],
  };
}

function build(verdict: Verdict, maxPer: number, policy?: Policy): HumanDigest & { omitted: number } {
  const headline = verdictHeadline(verdict, policy);
  const m: string[] = [];
  const t: string[] = [];
  const meta = `commit ${shortSha(verdict.headSha)}`;
  m.push(`## Merge Safely: ${headline}`, "", `<sub>${inline(meta)}</sub>`, "");
  t.push(`Verdict: ${headline}`, plain(meta));

  const why = verdict.tier.reasons.length > 0 ? verdict.tier.reasons.join("; ") : `score ${verdict.tier.score}`;
  m.push(`**Why tier ${verdict.tier.level}:** ${inline(why, 4000)}`);
  t.push(`Why tier ${verdict.tier.level}: ${plain(why, 4000, true)}`);

  if (verdict.triaged) {
    const reason = verdict.triageReason ?? "deterministic triage";
    m.push("", `**Triaged:** ${inline(reason, 500)} — no reviewer seats were run.`);
    t.push(`Triaged: ${plain(reason, 500, true)} — no reviewer seats were run.`);
  } else {
    const q = verdict.quorum;
    const quorum = `${q.required} required, ${q.passed} passed, ${q.blocked} blocked, ${q.invalid} invalid`;
    m.push("", `**Quorum:** ${quorum}`);
    t.push(`Quorum: ${quorum}`);
  }
  if (verdict.kind === "human" && verdict.signedBy) {
    const signed = `${verdict.signedBy.login}${verdict.reason ? `: ${verdict.reason}` : ""}`;
    m.push("", `**Signed by:** ${inline(signed, 1000)}`);
    t.push(`Signed by: ${plain(signed, 1000, true)}`);
  }
  const problems = seatProblems(verdict.seats);
  if (problems.md.length > 0) {
    m.push("", ...problems.md);
    t.push(...problems.text);
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
    tail.md.push(`**${a}**${n ? ` ${inline(n.trim(), 2000)}` : ""}`);
    tail.text.push(`${a}${n}`);
  }
  if (verdict.seats.length > 0) {
    const files = new Set(verdict.seats.flatMap((s) => s.audit.filesRead)).size;
    const commands = verdict.seats.reduce((n, s) => n + s.audit.commandsRun.length, 0);
    const insufficient = verdict.seats.filter((s) => s.status === "insufficient-work").length;
    const effort = `${plural(files, "file")} read, ${plural(commands, "command")}${
      insufficient > 0 ? `; ${plural(insufficient, "seat")} rejected for insufficient work` : ""
    }.`;
    tail.md.push(`**Reviewer effort:** ${effort}`);
    tail.text.push(`Reviewer effort: ${effort}`);
  }
  const downgrades = verdict.downgrades ?? [];
  if (downgrades.length > 0) {
    const d = downgrades
      .map((s) => `${s.step}${s.from || s.to ? ` (${s.from ?? "?"} → ${s.to ?? "?"})` : ""}: ${s.reason}`)
      .join("; ");
    tail.md.push(`**Downgrades applied:** ${inline(d, 2000)}`);
    tail.text.push(`Downgrades applied: ${plain(d, 2000, true)}`);
  }
  const seatDowngrades = verdict.seats.filter((s) => s.seat.downgradedFrom);
  if (seatDowngrades.length > 0) {
    const d = seatDowngrades
      .map((s) => `${s.seat.id}: ${s.seat.downgradedFrom?.name ?? "?"} → ${s.seat.model.name}`)
      .join("; ");
    tail.md.push(`**Seats downgraded:** ${inline(d, 2000)}`);
    tail.text.push(`Seats downgraded: ${plain(d, 2000, true)}`);
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
 * Render the human digest for a verdict (design section 4.3): headline, why this tier, quorum, seats that
 * did not count, findings grouped by severity, rounds progress, reviewer effort, downgrades,
 * contested/escalated notes and cost. All model, author and policy text is redacted and rendered as data
 * (titles inline, bodies in blockquotes). Markdown is GitHub-flavoured and kept under MAX_DIGEST_CHARS by
 * showing fewer findings per severity, then by truncating at a line boundary, with a note either way.
 */
export function renderDigest(verdict: Verdict, opts: DigestOptions = {}): HumanDigest {
  let maxPer = Math.max(1, opts.maxFindingsPerSeverity ?? DEFAULT_MAX_PER_SEVERITY);
  let out = build(verdict, maxPer, opts.policy);
  while (out.markdown.length > MAX_DIGEST_CHARS && maxPer > 1) {
    maxPer = Math.max(1, Math.floor(maxPer / 2));
    out = build(verdict, maxPer, opts.policy);
  }
  let { markdown } = out;
  if (markdown.length > MAX_DIGEST_CHARS) {
    markdown = truncateAtLine(
      markdown,
      MAX_DIGEST_CHARS,
      "\n\n_Digest truncated to fit the GitHub size limit; see the full verdict for every finding._",
    );
  } else if (out.omitted > 0) {
    markdown += `\n\n_${out.omitted} findings not shown to keep this summary readable; all are in the stored verdict._`;
  }
  const text = truncateAtLine(out.text, MAX_DIGEST_CHARS, "\n…(truncated)");
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
  const why = args.tier.reasons.join("; ");
  const fixTail = "in .merge-safely.yml or wait for the window to roll over.";
  const markdown = [
    `## Merge Safely: BLOCKED BY BUDGET (tier ${args.tier.level})`,
    `**Ceiling hit:** ${code(args.ceiling)}`,
    `**Reason:** ${inline(args.reason, 1000)}`,
    ...(est ? [est] : []),
    ...(why ? [`**Why tier ${args.tier.level}:** ${inline(why, 4000)}`] : []),
    `To review this change, raise ${code(`budget.${args.ceiling}`)} ${fixTail}`,
  ].join("\n\n");
  const text = [
    headline,
    `Ceiling hit: ${plain(args.ceiling, 200, true)}`,
    `Reason: ${plain(args.reason, 1000, true)}`,
    ...(est ? [est] : []),
    ...(why ? [`Why tier ${args.tier.level}: ${plain(why, 4000, true)}`] : []),
    `To review this change, raise budget.${plain(args.ceiling, 200, true)} ${fixTail}`,
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
    ...(why ? ["", `**Why tier ${tier?.level}:** ${inline(why, 4000)}`] : []),
  ].join("\n");
  const text = [headline, body, ...(why ? [`Why tier ${tier?.level}: ${plain(why, 4000, true)}`] : [])].join("\n");
  return { headline, markdown, text };
}
