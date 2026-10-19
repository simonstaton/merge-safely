import { createHash } from "node:crypto";
import type { Finding, Severity } from "../types.js";

/** Lines per fingerprint window: a finding that drifts within its 10-line window keeps its id. */
export const LINE_WINDOW = 10;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "of",
  "to",
  "for",
  "is",
  "are",
  "be",
  "and",
  "or",
  "with",
  "at",
  "by",
  "this",
  "that",
  "it",
  "its",
  "line",
  "lines",
]);

/**
 * Normalise a finding title into a stable word key: lower-cased, punctuation stripped, stopwords and pure
 * numbers (often line numbers) dropped, de-duplicated and sorted, so "Missing null check at line 42" and
 * "null check missing" produce the same key.
 */
export function normaliseTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].sort().join(" ");
}

function normalisePath(p: string): string {
  let out = p
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/^\/+/, "");
}

export type FindingDraft = Omit<Finding, "id"> & { id?: string };

/**
 * Fingerprint per design section 3: first 10 hex chars of sha256 over (normalised path, 10-line window,
 * class). The title is deliberately not hashed for findings with a file, because models reword titles
 * between rounds and the id must survive that. Two same-class findings in one window share an id and are
 * merged by dedupe. With a file but no line the window is "*"; with no file there is nothing to anchor
 * on, so (class, normalised title) is hashed. Any id the model supplied is ignored.
 */
export function fingerprintFinding(f: FindingDraft): string {
  const cls = f.class.trim().toLowerCase();
  const file = f.file ? normalisePath(f.file) : "";
  const parts =
    file === ""
      ? ["nofile", cls, normaliseTitle(f.title)]
      : ["file", file, f.line !== undefined && f.line > 0 ? String(Math.floor((f.line - 1) / LINE_WINDOW)) : "*", cls];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 10);
}

/** Assign core fingerprints to every finding, overwriting whatever id it carried. */
export function assignFingerprints(findings: FindingDraft[]): Finding[] {
  return findings.map((f) => ({ ...f, id: fingerprintFinding(f) }));
}

export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, important: 1, nit: 2, "pre-existing": 3 };

/** The more severe of two severities (blocker > important > nit > pre-existing). */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** The less severe of two severities. */
export function minSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function union<T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Merge findings sharing a fingerprint, preserving first-seen order. Merged: lenses and evidence (union),
 * severity (highest), detail and suggestedFix (longest), votes (concatenated). Ids are always recomputed
 * from content, so an id a model wrote can never merge a real blocker into a dropped style finding.
 */
export function dedupeFindings(findings: Array<Finding | FindingDraft>): Finding[] {
  const byId = new Map<string, Finding>();
  for (const raw of findings) {
    const f: Finding = { ...raw, id: fingerprintFinding(raw) };
    const prior = byId.get(f.id);
    if (!prior) {
      byId.set(f.id, { ...f });
      continue;
    }
    prior.severity = maxSeverity(prior.severity, f.severity);
    if (f.detail.length > prior.detail.length) prior.detail = f.detail;
    if (f.suggestedFix && f.suggestedFix.length > (prior.suggestedFix?.length ?? 0))
      prior.suggestedFix = f.suggestedFix;
    const lenses = union(prior.lenses, f.lenses);
    if (lenses) prior.lenses = lenses;
    const evidence = union(prior.evidence, f.evidence);
    if (evidence) prior.evidence = evidence;
    if (f.votes) prior.votes = [...(prior.votes ?? []), ...f.votes];
    if (prior.line === undefined && f.line !== undefined) prior.line = f.line;
    if (prior.endLine === undefined && f.endLine !== undefined) prior.endLine = f.endLine;
  }
  return [...byId.values()];
}
