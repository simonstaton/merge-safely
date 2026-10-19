import type { Decision, Finding, RepoRef, Severity, TierLevel, Verdict } from "@merge-safely/core";
import { GITHUB_TEXT_LIMIT } from "./util.js";

/**
 * Round history that survives force-pushes. `pulls.listCommits` only returns commits reachable from
 * the current head, so after an amend/rebase + force-push the check runs of earlier SHAs are no
 * longer discoverable from the PR. The store therefore keeps one bot-authored PR comment holding a
 * compact entry per verdict it wrote. Only the comment posted by our own bot login is read.
 *
 * Capped at 65,535 chars: when over, finding details are dropped oldest-first (first titles and
 * locations, then the finding list). headSha, round and decision are never dropped.
 */
export const INDEX_MARKER = "<!-- merge-safely:index -->";

export interface IndexFinding {
  id: string;
  severity: Severity;
  class?: string;
  title?: string;
  file?: string;
  line?: number;
}

export interface IndexEntry {
  headSha: string;
  round: number;
  decision: Decision;
  createdAt: string;
  policyHash: string;
  /** Extension: tier level and kind, so hydrated verdicts keep what planRound/canAcceptVerdict read. */
  tier?: TierLevel;
  kind?: "human";
  findings: IndexFinding[];
}

const SEVERITIES = ["blocker", "important", "nit", "pre-existing"];
const DECISIONS = ["pass", "block", "pending"];

export function toIndexEntry(v: Verdict): IndexEntry {
  return {
    headSha: v.headSha,
    round: v.round,
    decision: v.decision,
    createdAt: v.createdAt,
    policyHash: v.policyHash,
    tier: v.tier.level,
    ...(v.kind === "human" ? { kind: "human" as const } : {}),
    findings: v.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      class: f.class,
      title: f.title.slice(0, 200),
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
    })),
  };
}

/** Insert or replace the entry for (headSha, round); keep oldest first. */
export function upsertEntry(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  const rest = entries.filter((e) => !(e.headSha === entry.headSha && e.round === entry.round));
  return [...rest, entry].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.round - b.round);
}

/** Expand a compact entry into a Verdict (no seats, zero cost, machine unless recorded as human). */
export function hydrateEntry(e: IndexEntry, repo: RepoRef, number: number): Verdict {
  const findings: Finding[] = e.findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    class: f.class ?? "unknown",
    title: f.title ?? "",
    detail: "",
    ...(f.file ? { file: f.file } : {}),
    ...(f.line ? { line: f.line } : {}),
  }));
  return {
    repo,
    number,
    headSha: e.headSha,
    kind: e.kind ?? "machine",
    decision: e.decision,
    tier: {
      level: e.tier ?? 0,
      score: 0,
      factors: { loc: 0, files: 0, modules: 0, criticalPathHits: [] },
      reasons: ["restored from the merge-safely round index"],
    },
    round: e.round,
    triaged: false,
    seats: [],
    findings,
    quorum: { required: 0, passed: 0, blocked: 0, invalid: 0 },
    cost: { tokens: { in: 0, out: 0 }, bySeat: {} },
    createdAt: e.createdAt,
    policyHash: e.policyHash,
  };
}

function wrap(json: string): string {
  return (
    `${INDEX_MARKER}\n<details><summary>Merge Safely round history (maintained by the bot, do not edit)</summary>\n\n` +
    `\`\`\`json\n${json}\n\`\`\`\n</details>`
  );
}

/** Render the index comment body within GitHub's 65,535-char limit (see module doc for what is dropped). */
export function renderIndex(entries: IndexEntry[], max = GITHUB_TEXT_LIMIT): string {
  const work = entries.map((e) => ({ ...e, findings: e.findings.map((f) => ({ ...f })) }));
  const render = () => wrap(JSON.stringify({ v: 1, entries: work }));
  let body = render();
  // Pass 1: strip finding details (title, class, location) oldest-first.
  for (let i = 0; i < work.length && body.length > max; i++) {
    const e = work[i];
    if (!e) continue;
    e.findings = e.findings.map((f) => ({ id: f.id, severity: f.severity }));
    body = render();
  }
  // Pass 2: drop the finding lists themselves, oldest-first.
  for (let i = 0; i < work.length && body.length > max; i++) {
    const e = work[i];
    if (!e) continue;
    e.findings = [];
    body = render();
  }
  return body;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function validEntry(x: unknown): x is IndexEntry {
  return (
    isObj(x) &&
    typeof x.headSha === "string" &&
    typeof x.round === "number" &&
    typeof x.decision === "string" &&
    DECISIONS.includes(x.decision) &&
    typeof x.createdAt === "string" &&
    typeof x.policyHash === "string" &&
    Array.isArray(x.findings) &&
    x.findings.every(
      (f) => isObj(f) && typeof f.id === "string" && typeof f.severity === "string" && SEVERITIES.includes(f.severity),
    )
  );
}

/** Parse an index comment body. Null when the marker or a well-formed block is missing. */
export function parseIndex(body: string | null | undefined): IndexEntry[] | null {
  if (!body) return null;
  const at = body.indexOf(INDEX_MARKER);
  if (at < 0) return null;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(body.slice(at));
  if (!m?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (_err: unknown) {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  return raw.entries.filter(validEntry);
}
