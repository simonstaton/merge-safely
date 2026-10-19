/**
 * Eval metrics and reports (design section 10): recall on incidents, false-block rate on known-clean changes,
 * tier accuracy, attribution per lens and per model, cost and duration, plus before/after comparison.
 */
import type { TierLevel } from "@merge-safely/core";
import { isCaught, isUnresolved, matchingFindings } from "./score.js";
import type { CaseKind, SuiteGates } from "./suite.js";
import type { CaseResult, SuiteResult } from "./types.js";

export interface AttributionStats {
  /** Cases where this lens/model held a hunter seat. */
  seated: number;
  /** Incident cases (that blocked) where it raised a finding matching the expectation. */
  incidentsCaught: number;
  /** Incident cases where it was seated. */
  incidentsSeated: number;
  /** incidentsCaught / incidentsSeated, null when never seated on an incident. */
  recall: number | null;
  /** Clean cases that blocked where it raised a blocker. */
  cleanBlocks: number;
  cleanSeated: number;
  falseBlockRate: number | null;
  /** All findings it raised across the suite. */
  findings: number;
}

export interface TierStats {
  incidents: number;
  /** Incidents caught: blocked with the expected class/file when the case names one. */
  blocked: number;
  /** Incidents whose actual tier is below the expected tier (a tiering rule is missing, not quorum). */
  underTiered: number;
  recall: number | null;
  /** Missed incidents that triage auto-passed (no reviewer saw them). */
  missedByTriage: number;
}

export interface SuiteSummary {
  dry: boolean;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  byKind: Record<CaseKind, { total: number; passed: number }>;
  incidents: number;
  /** Incidents that blocked for any reason (raw block rate numerator). */
  incidentsBlocked: number;
  /** Incidents that blocked with the expected class/file (when the case names one). */
  incidentsCaught: number;
  /** incidentsCaught / incidents; null in dry mode or without incident cases. */
  recall: number | null;
  clean: number;
  cleanBlocked: number;
  /** cleanBlocked / clean (all clean cases, resolved or not); null in dry mode or without clean cases. */
  falseBlockRate: number | null;
  /** Cases with no usable decision: errored, pending, contested. Each one is a case failure. */
  unresolved: number;
  tierChecked: number;
  tierCorrect: number;
  tierAccuracy: number | null;
  /** Keyed by the actual tier the gate assigned (falling back to the expected tier when it never ran). */
  perTier: Partial<Record<`${TierLevel}`, TierStats>>;
  perLens: Record<string, AttributionStats>;
  perModel: Record<string, AttributionStats>;
  cost: { totalUsd: number; perCase: Record<string, number | null>; meanUsd: number | null; unpriced: number };
  durationMs: { total: number; p50: number; p95: number };
  gates: SuiteGates;
  /** Why the suite fails its gates; empty when ok. */
  gateFailures: string[];
  ok: boolean;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

/** Nearest-rank percentile of a list of numbers (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

const emptyAttribution = (): AttributionStats => ({
  seated: 0,
  incidentsCaught: 0,
  incidentsSeated: 0,
  recall: null,
  cleanBlocks: 0,
  cleanSeated: 0,
  falseBlockRate: null,
  findings: 0,
});

function attribute(
  cases: CaseResult[],
  keysSeated: (c: CaseResult) => string[],
  keysOf: (f: CaseResult["actual"]["findings"][number]) => string[],
): Record<string, AttributionStats> {
  const out: Record<string, AttributionStats> = {};
  const get = (k: string) => {
    out[k] ??= emptyAttribution();
    return out[k];
  };
  for (const c of cases) {
    if (c.actual.status !== "ok") continue;
    const seated = new Set(keysSeated(c));
    for (const k of seated) {
      const s = get(k);
      s.seated++;
      if (c.kind === "incident") s.incidentsSeated++;
      if (c.kind === "clean") s.cleanSeated++;
    }
    for (const f of c.actual.findings) for (const k of new Set(keysOf(f))) get(k).findings++;
    if (c.kind === "incident" && isCaught(c.expected, c.actual)) {
      const caught = new Set(matchingFindings(c.expected, c.actual.findings).flatMap(keysOf));
      for (const k of caught) get(k).incidentsCaught++;
    }
    if (c.kind === "clean" && c.actual.decision === "block") {
      const blockers = new Set(c.actual.findings.filter((f) => f.severity === "blocker").flatMap(keysOf));
      for (const k of blockers) get(k).cleanBlocks++;
    }
  }
  for (const s of Object.values(out)) {
    s.recall = ratio(s.incidentsCaught, s.incidentsSeated);
    s.falseBlockRate = ratio(s.cleanBlocks, s.cleanSeated);
  }
  return out;
}

/** Aggregate case results into the suite summary and evaluate the suite gates. Pure. */
export function summarize(cases: CaseResult[], opts: { gates: SuiteGates; dry: boolean }): SuiteSummary {
  const { gates, dry } = opts;
  const byKind: SuiteSummary["byKind"] = {
    incident: { total: 0, passed: 0 },
    clean: { total: 0, passed: 0 },
    regression: { total: 0, passed: 0 },
  };
  for (const c of cases) {
    byKind[c.kind].total++;
    if (c.passed) byKind[c.kind].passed++;
  }
  const incidents = cases.filter((c) => c.kind === "incident");
  const clean = cases.filter((c) => c.kind === "clean");
  const incidentsBlocked = incidents.filter((c) => c.actual.status === "ok" && c.actual.decision === "block").length;
  const incidentsCaught = incidents.filter((c) => isCaught(c.expected, c.actual)).length;
  const unresolved = cases.filter((c) => isUnresolved(c.actual)).length;
  const cleanBlocked = clean.filter((c) => c.actual.status === "ok" && c.actual.decision === "block").length;
  const tierCases = cases.filter((c) => c.expected.tier !== undefined && c.actual.status !== "error");
  const tierCorrect = tierCases.filter((c) => c.actual.tier === c.expected.tier).length;

  const perTier: SuiteSummary["perTier"] = {};
  for (const c of incidents) {
    const level = c.actual.tier ?? c.expected.tier;
    if (level === undefined) continue;
    const key = `${level}` as const;
    const t = perTier[key] ?? { incidents: 0, blocked: 0, underTiered: 0, recall: null, missedByTriage: 0 };
    perTier[key] = t;
    t.incidents++;
    if (c.expected.tier !== undefined && c.actual.tier !== undefined && c.actual.tier < c.expected.tier) {
      t.underTiered++;
    }
    if (isCaught(c.expected, c.actual)) t.blocked++;
    else if (c.actual.triage === "auto-pass") t.missedByTriage++;
  }
  for (const t of Object.values(perTier)) t.recall = dry ? null : ratio(t.blocked, t.incidents);

  const perCase: Record<string, number | null> = {};
  let totalUsd = 0;
  let priced = 0;
  for (const c of cases) {
    const usd = dry ? c.actual.cost.estimateUsd : c.actual.cost.usd;
    perCase[c.id] = usd ?? null;
    if (usd !== undefined) {
      totalUsd += usd;
      priced++;
    }
  }
  const durations = cases.map((c) => c.durationMs);

  const recall = dry ? null : ratio(incidentsCaught, incidents.length);
  const falseBlockRate = dry ? null : ratio(cleanBlocked, clean.length);
  const errors = cases.filter((c) => c.actual.status === "error").length;
  const gateFailures: string[] = [];
  if (errors > 0) gateFailures.push(`${errors} case(s) errored; an eval that cannot run is not evidence`);
  const pendingOrContested = unresolved - errors;
  if (!dry && pendingOrContested > 0) {
    gateFailures.push(`${pendingOrContested} case(s) unresolved (pending or contested verdict)`);
  }
  // Every failed case fails the suite: rates summarise, they do not excuse individual misses.
  const failedCases = cases.filter((c) => !c.passed && !isUnresolved(c.actual));
  if (failedCases.length > 0) {
    gateFailures.push(
      `${failedCases.length} case(s) failed${dry ? " dry-run checks" : ""}: ${failedCases.map((c) => c.id).join(", ")}`,
    );
  }
  if (!dry) {
    if (recall !== null && recall < gates.minRecall) {
      gateFailures.push(`recall ${pct(recall)} is below minRecall ${pct(gates.minRecall)}`);
    }
    if (falseBlockRate !== null && falseBlockRate > gates.maxFalseBlock) {
      gateFailures.push(`false-block rate ${pct(falseBlockRate)} is above maxFalseBlock ${pct(gates.maxFalseBlock)}`);
    }
  }

  return {
    dry,
    total: cases.length,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    errors,
    byKind,
    incidents: incidents.length,
    incidentsBlocked,
    incidentsCaught,
    recall,
    clean: clean.length,
    cleanBlocked,
    falseBlockRate,
    unresolved,
    tierChecked: tierCases.length,
    tierCorrect,
    tierAccuracy: ratio(tierCorrect, tierCases.length),
    perTier,
    perLens: dry
      ? {}
      : attribute(
          cases,
          (c) => c.actual.lenses,
          (f) => f.lenses,
        ),
    perModel: dry
      ? {}
      : attribute(
          cases,
          (c) => c.actual.models,
          (f) => f.models,
        ),
    cost: { totalUsd, perCase, meanUsd: priced === 0 ? null : totalUsd / priced, unpriced: cases.length - priced },
    durationMs: {
      total: durations.reduce((a, b) => a + b, 0),
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
    },
    gates,
    gateFailures,
    ok: gateFailures.length === 0,
  };
}

/** CLI exit code for a result: 0 when every gate holds, 1 otherwise. */
export function exitCodeFor(result: SuiteResult): number {
  return result.summary.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type ReportFormat = "text" | "markdown" | "json";

export function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : `$${n.toFixed(2)}`);
const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

function caseDecision(c: CaseResult): string {
  if (c.actual.status === "error") return "error";
  return c.actual.decision;
}

function attributionRows(stats: Record<string, AttributionStats>): string[][] {
  return Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, s]) => [
      k,
      String(s.seated),
      `${s.incidentsCaught}/${s.incidentsSeated}`,
      pct(s.recall),
      `${s.cleanBlocks}/${s.cleanSeated}`,
      pct(s.falseBlockRate),
      String(s.findings),
    ]);
}

const ATTR_HEAD = ["", "seated", "caught", "recall", "clean blocks", "false-block", "findings"];

function textTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) =>
    r
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)];
}

const mdEscape = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function mdTable(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.map(mdEscape).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(mdEscape).join(" | ")} |`),
  ];
}

function caseRows(result: SuiteResult): string[][] {
  return result.cases.map((c) => [
    c.passed ? "PASS" : "FAIL",
    c.id,
    c.kind,
    `${c.expected.decision}${c.expected.tier !== undefined ? ` t${c.expected.tier}` : ""}`,
    `${caseDecision(c)}${c.actual.tier !== undefined ? ` t${c.actual.tier}` : ""}`,
    c.actual.triage ?? "-",
    String(c.actual.seats),
    result.suite.dry ? "-" : usd(c.actual.cost.usd),
    ms(c.durationMs),
  ]);
}

const CASE_HEAD = ["", "case", "kind", "expected", "actual", "triage", "seats", "cost", "time"];

function headlineLines(r: SuiteResult): string[] {
  const s = r.summary;
  const lines = [
    `${s.ok ? "OK" : "FAILED"}: ${s.passed}/${s.total} cases passed${s.dry ? " (dry run: estimate only, no model calls)" : ""}`,
  ];
  if (!s.dry) {
    lines.push(
      `Recall (incidents caught for the expected reason): ${s.incidentsCaught}/${s.incidents} = ${pct(s.recall)} (min ${pct(s.gates.minRecall)}); ${s.incidentsBlocked} blocked for any reason`,
      `False-block rate (clean blocked): ${s.cleanBlocked}/${s.clean} = ${pct(s.falseBlockRate)} (max ${pct(s.gates.maxFalseBlock)})`,
      `Unresolved (error, pending or contested): ${s.unresolved}`,
    );
  }
  lines.push(`Tier accuracy: ${s.tierCorrect}/${s.tierChecked} = ${pct(s.tierAccuracy)}`);
  lines.push(
    s.dry
      ? "Cost: not estimated (dry)"
      : `Cost: ${usd(s.cost.totalUsd)} total, ${usd(s.cost.meanUsd)} mean per priced case${s.cost.unpriced > 0 ? `, ${s.cost.unpriced} unpriced` : ""}`,
    `Duration: p50 ${ms(s.durationMs.p50)}, p95 ${ms(s.durationMs.p95)}, total ${ms(s.durationMs.total)}`,
  );
  return lines;
}

function failureLines(r: SuiteResult, bullet: string): string[] {
  return r.cases
    .filter((c) => !c.passed)
    .flatMap((c) => [`${bullet}${c.id} (${c.kind}): ${c.title}`, ...c.reasons.map((x) => `    - ${x}`)]);
}

function renderText(r: SuiteResult): string {
  const s = r.summary;
  const out = [`Eval suite: ${r.suite.name}`, ...headlineLines(r)];
  for (const g of s.gateFailures) out.push(`  gate: ${g}`);
  out.push("", ...textTable(CASE_HEAD, caseRows(r)));
  const failures = failureLines(r, "  ");
  if (failures.length > 0) out.push("", "Failures", ...failures);
  if (!s.dry && Object.keys(s.perLens).length > 0) {
    out.push("", "Per lens", ...textTable(["lens", ...ATTR_HEAD.slice(1)], attributionRows(s.perLens)));
  }
  if (!s.dry && Object.keys(s.perModel).length > 0) {
    out.push("", "Per model", ...textTable(["model", ...ATTR_HEAD.slice(1)], attributionRows(s.perModel)));
  }
  return `${out.join("\n")}\n`;
}

function renderMarkdown(r: SuiteResult): string {
  const s = r.summary;
  const out = [
    `## Eval suite: ${r.suite.name}`,
    "",
    ...headlineLines(r).map((l, i) => (i === 0 ? `**${l}**` : `- ${l}`)),
  ];
  if (s.gateFailures.length > 0) out.push("", "**Gate failures**", ...s.gateFailures.map((g) => `- ${g}`));
  out.push(
    "",
    "### Cases",
    "",
    ...mdTable(
      CASE_HEAD.map((h, i) => (i === 0 ? "result" : h)),
      caseRows(r),
    ),
  );
  const failures = failureLines(r, "- ");
  if (failures.length > 0) out.push("", "### Failures", "", ...failures);
  if (!s.dry && Object.keys(s.perLens).length > 0) {
    out.push("", "### Per lens", "", ...mdTable(["lens", ...ATTR_HEAD.slice(1)], attributionRows(s.perLens)));
  }
  if (!s.dry && Object.keys(s.perModel).length > 0) {
    out.push("", "### Per model", "", ...mdTable(["model", ...ATTR_HEAD.slice(1)], attributionRows(s.perModel)));
  }
  return `${out.join("\n")}\n`;
}

export function renderReport(result: SuiteResult, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (format === "markdown") return renderMarkdown(result);
  return renderText(result);
}

// ---------------------------------------------------------------------------
// Before/after comparison
// ---------------------------------------------------------------------------

export interface CaseFlip {
  id: string;
  kind: CaseKind;
  before: { passed: boolean; decision: string; tier?: TierLevel };
  after: { passed: boolean; decision: string; tier?: TierLevel };
  /** fixed: failed -> passed; regressed: passed -> failed; changed: same pass state, different decision or tier. */
  change: "fixed" | "regressed" | "changed";
}

export interface ReportComparison {
  flips: CaseFlip[];
  fixed: string[];
  regressed: string[];
  added: string[];
  removed: string[];
  delta: {
    recall: number | null;
    falseBlockRate: number | null;
    tierAccuracy: number | null;
    totalUsd: number;
    p95Ms: number;
  };
}

const diffOrNull = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);

/** Compare a baseline result `a` with a new result `b` (e.g. before and after a policy or model change). */
export function compareReports(a: SuiteResult, b: SuiteResult): ReportComparison {
  const before = new Map(a.cases.map((c) => [c.id, c]));
  const after = new Map(b.cases.map((c) => [c.id, c]));
  const flips: CaseFlip[] = [];
  for (const [id, cb] of after) {
    const ca = before.get(id);
    if (!ca) continue;
    const da = caseDecision(ca);
    const db = caseDecision(cb);
    let change: CaseFlip["change"] | null = null;
    if (ca.passed && !cb.passed) change = "regressed";
    else if (!ca.passed && cb.passed) change = "fixed";
    else if (da !== db || ca.actual.tier !== cb.actual.tier) change = "changed";
    if (!change) continue;
    const side = (c: CaseResult, d: string) => ({
      passed: c.passed,
      decision: d,
      ...(c.actual.tier !== undefined ? { tier: c.actual.tier } : {}),
    });
    flips.push({ id, kind: cb.kind, before: side(ca, da), after: side(cb, db), change });
  }
  return {
    flips,
    fixed: flips.filter((f) => f.change === "fixed").map((f) => f.id),
    regressed: flips.filter((f) => f.change === "regressed").map((f) => f.id),
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    delta: {
      recall: diffOrNull(a.summary.recall, b.summary.recall),
      falseBlockRate: diffOrNull(a.summary.falseBlockRate, b.summary.falseBlockRate),
      tierAccuracy: diffOrNull(a.summary.tierAccuracy, b.summary.tierAccuracy),
      totalUsd: b.summary.cost.totalUsd - a.summary.cost.totalUsd,
      p95Ms: b.summary.durationMs.p95 - a.summary.durationMs.p95,
    },
  };
}

const signedPct = (n: number | null): string => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${pct(n)}`);

export function renderComparison(cmp: ReportComparison, format: "text" | "markdown" = "text"): string {
  const b = format === "markdown" ? "- " : "  ";
  const out = [
    format === "markdown" ? "## Eval comparison" : "Eval comparison",
    `${b}recall ${signedPct(cmp.delta.recall)}, false-block ${signedPct(cmp.delta.falseBlockRate)}, tier accuracy ${signedPct(cmp.delta.tierAccuracy)}`,
    `${b}cost ${cmp.delta.totalUsd >= 0 ? "+" : "-"}$${Math.abs(cmp.delta.totalUsd).toFixed(2)}, p95 ${cmp.delta.p95Ms >= 0 ? "+" : ""}${ms(cmp.delta.p95Ms)}`,
  ];
  for (const f of cmp.flips) {
    out.push(
      `${b}${f.change.toUpperCase()} ${f.id} (${f.kind}): ${f.before.decision}${f.before.tier !== undefined ? ` t${f.before.tier}` : ""} -> ${f.after.decision}${f.after.tier !== undefined ? ` t${f.after.tier}` : ""}`,
    );
  }
  if (cmp.added.length > 0) out.push(`${b}added: ${cmp.added.join(", ")}`);
  if (cmp.removed.length > 0) out.push(`${b}removed: ${cmp.removed.join(", ")}`);
  if (cmp.flips.length === 0 && cmp.added.length === 0 && cmp.removed.length === 0) out.push(`${b}no case changed`);
  return `${out.join("\n")}\n`;
}
