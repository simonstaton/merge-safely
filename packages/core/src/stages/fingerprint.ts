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
  return mergeCrossClassDuplicates([...byId.values()]);
}

/** Jaccard overlap of two normalised title word sets. */
function titleOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter(Boolean));
  const wb = new Set(b.split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * Two hunters often report one bug under different classes (e.g. logic-error vs failing-path) with reworded
 * titles. Measured on real runs the same bug scores ~0.35 Jaccard overlap and distinct bugs in the same
 * window score ~0.1–0.2, so 0.3 separates them; the extra guard is that the two findings must come from
 * different lenses (one reviewer does not report the same bug twice).
 */
const CROSS_CLASS_TITLE_OVERLAP = 0.3;

function lensesDisjoint(a: Finding, b: Finding): boolean {
  if (!a.lenses?.length || !b.lenses?.length) return true;
  return !a.lenses.some((l) => b.lenses?.includes(l));
}

/**
 * Second dedupe pass: findings anchored on the same file and line window, raised by different lenses, whose
 * normalised titles overlap enough are the same bug reported under two classes. The higher-severity one wins
 * (its id and class are kept); the other class is recorded in evidence so nothing is lost from the provenance.
 */
export function mergeCrossClassDuplicates(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  const titles = new Map<Finding, string>();
  for (const f of findings) titles.set(f, normaliseTitle(f.title));
  for (const f of findings) {
    const window = f.file && f.line !== undefined && f.line > 0 ? Math.floor((f.line - 1) / LINE_WINDOW) : undefined;
    const twin = out.find((o) => {
      if (!f.file || !o.file || normalisePath(o.file) !== normalisePath(f.file)) return false;
      const ow = o.line !== undefined && o.line > 0 ? Math.floor((o.line - 1) / LINE_WINDOW) : undefined;
      if (ow !== window) return false;
      if (!lensesDisjoint(o, f)) return false;
      return titleOverlap(titles.get(o) ?? "", titles.get(f) ?? "") >= CROSS_CLASS_TITLE_OVERLAP;
    });
    if (!twin) {
      out.push(f);
      continue;
    }
    const [keep, drop] = SEVERITY_RANK[f.severity] < SEVERITY_RANK[twin.severity] ? [f, twin] : [twin, f];
    const merged: Finding = {
      ...keep,
      detail: keep.detail.length >= drop.detail.length ? keep.detail : drop.detail,
      suggestedFix: keep.suggestedFix ?? drop.suggestedFix,
      lenses: union(keep.lenses, drop.lenses),
      evidence: union(union(keep.evidence, drop.evidence), [`also reported as ${drop.class} (#${drop.id})`]),
      votes: keep.votes || drop.votes ? [...(keep.votes ?? []), ...(drop.votes ?? [])] : undefined,
    };
    out[out.indexOf(twin)] = merged;
  }
  return out;
}
