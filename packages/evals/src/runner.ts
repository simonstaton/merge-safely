/**
 * Eval runner: load a suite, materialise every case, run it through a freshly built gate and score it.
 *
 * Each case gets its own gate built by `gateFactory` with a fresh in-memory verdict store and cost ledger, so no
 * state (stored blocks, spend, rounds) leaks between cases. `estimate` always runs first and records tier, triage and
 * seating; `dry` stops there and never calls `reviewChange`, so no model is contacted.
 */
import { type Change, loadPolicy, type Policy, type PolicyInput, type Verdict } from "@merge-safely/core";
import type { OctokitLike } from "@merge-safely/github";
import { memoryCostLedger, memoryVerdictStore } from "@merge-safely/store-memory";
import { type EvalGate, estimateOnlyGateFactory, type GateEstimate, type GateFactory } from "./gate.js";
import { materializeCase } from "./materialize.js";
import { summarize } from "./report.js";
import { evaluateCase } from "./score.js";
import { type CaseKind, casePolicyInput, type LoadedCase, type LoadedSuite, loadSuite } from "./suite.js";
import type { ActualFinding, CaseActual, CaseResult, SuiteResult } from "./types.js";

export { evaluateCase, matchingFindings } from "./score.js";
export type { ActualFinding, CaseActual, CaseResult, CaseStatus, SuiteResult } from "./types.js";

export interface RunSuiteOptions {
  /** Builds a gate for one case. Required unless `dry`; dry runs default to the real core stages. */
  gateFactory?: GateFactory;
  /** Applied on top of suite and case policy for every case. */
  policyOverride?: PolicyInput | Record<string, unknown>;
  filter?: { ids?: string[]; kinds?: CaseKind[] };
  /** Cases run in parallel; default 1. */
  concurrency?: number;
  /** Estimate only: tier, triage and seating assertions, no model calls. */
  dry?: boolean;
  onCase?: (result: CaseResult) => void;
  github?: { octokit: OctokitLike };
  /** Wall clock for durations; injectable for deterministic tests. */
  now?: () => number;
}

function findingsFromVerdict(v: Verdict): ActualFinding[] {
  const hunterModels = new Map<string, Set<string>>();
  for (const run of v.seats) {
    const set = hunterModels.get(run.seat.lens) ?? new Set<string>();
    set.add(run.seat.model.name);
    hunterModels.set(run.seat.lens, set);
  }
  return v.findings.map((f) => {
    const lenses = f.lenses ?? [];
    const models = [...new Set(lenses.flatMap((l) => [...(hunterModels.get(l) ?? [])]))];
    const out: ActualFinding = { class: f.class, severity: f.severity, lenses, models };
    if (f.file !== undefined) out.file = f.file;
    if (f.line !== undefined) out.line = f.line;
    if (lenses[0] !== undefined) out.lens = lenses[0];
    return out;
  });
}

function fromEstimate(est: GateEstimate, dry: boolean): CaseActual {
  const autoPass = est.triage?.decision === "auto-pass";
  const actual: CaseActual = {
    decision: autoPass ? "pass" : "not-run",
    tier: est.tier.level,
    tierReasons: est.tier.reasons,
    triage: autoPass ? "auto-pass" : "review",
    findings: [],
    cost: est.estimateUsd !== undefined ? { estimateUsd: est.estimateUsd } : {},
    seats: est.seats.length,
    lenses: est.seats.filter((s) => s.role === "hunter").map((s) => s.lens),
    models: [...new Set(est.seats.map((s) => s.model.name))],
    status: dry ? "dry" : "ok",
  };
  if (est.triage?.reason) actual.triageReason = est.triage.reason;
  return actual;
}

function withVerdict(actual: CaseActual, v: Verdict): CaseActual {
  const out: CaseActual = {
    ...actual,
    decision: v.decision,
    tier: v.tier.level,
    tierReasons: v.tier.reasons,
    findings: findingsFromVerdict(v),
    cost: { ...actual.cost, ...(v.cost.usd !== undefined ? { usd: v.cost.usd } : {}) },
    seats: v.seats.length,
    models: v.seats.length > 0 ? [...new Set(v.seats.map((r) => r.seat.model.name))] : actual.models,
    status: "ok",
  };
  if (v.seats.length > 0) out.lenses = v.seats.filter((r) => r.seat.role === "hunter").map((r) => r.seat.lens);
  if (v.triaged) {
    out.triage = "auto-pass";
    if (v.triageReason) out.triageReason = v.triageReason;
  }
  const failures = v.seats.filter((r) => r.status !== "ok").map((r) => `${r.seat.id}=${r.status}`);
  if (failures.length > 0) out.seatFailures = failures;
  return out;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function errorActual(error: string, partial?: CaseActual): CaseActual {
  return {
    ...(partial ?? { decision: "not-run", findings: [], cost: {}, seats: 0, lenses: [], models: [] }),
    status: "error",
    error,
  };
}

async function runCase(
  suite: LoadedSuite,
  lc: LoadedCase,
  index: number,
  opts: RunSuiteOptions,
  factory: GateFactory,
): Promise<CaseResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const spec = lc.spec;
  let actual: CaseActual | undefined;
  try {
    const policy: Policy = loadPolicy(casePolicyInput(suite.manifest, spec, opts.policyOverride));
    const m = await materializeCase(lc, index, opts.github ? { github: opts.github } : {});
    const change: Change = m.change;
    const gate: EvalGate = await factory(policy, {
      caseId: spec.id,
      store: memoryVerdictStore(),
      ledger: memoryCostLedger(),
    });
    actual = fromEstimate(await gate.estimate(change), opts.dry === true);
    if (!opts.dry) {
      const r = await gate.reviewChange(change, { diff: m.diff, untrusted: m.untrusted });
      actual = withVerdict(actual, r.verdict);
    }
  } catch (err: unknown) {
    actual = errorActual(errorMessage(err), actual);
  }
  const { passed, reasons } = evaluateCase(spec, actual);
  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    expected: spec.expected,
    actual,
    passed,
    reasons,
    durationMs: Math.max(0, now() - started),
  };
}

/** Select the cases a filter keeps (all when no filter). */
export function filterCases(cases: LoadedCase[], filter?: RunSuiteOptions["filter"]): LoadedCase[] {
  return cases.filter(
    (c) =>
      (!filter?.ids || filter.ids.length === 0 || filter.ids.includes(c.spec.id)) &&
      (!filter?.kinds || filter.kinds.length === 0 || filter.kinds.includes(c.spec.kind)),
  );
}

/** Run an already loaded suite. */
export async function runLoadedSuite(suite: LoadedSuite, opts: RunSuiteOptions = {}): Promise<SuiteResult> {
  const factory = opts.gateFactory ?? (opts.dry ? estimateOnlyGateFactory : undefined);
  if (!factory) throw new Error("runSuite: gateFactory is required for full runs (or pass dry: true)");
  if (opts.filter?.ids) {
    const known = new Set(suite.cases.map((c) => c.spec.id));
    const unknown = opts.filter.ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`runSuite: unknown case id(s): ${unknown.join(", ")}`);
  }
  const selected = filterCases(suite.cases, opts.filter);
  const results: CaseResult[] = new Array(selected.length);
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const i = next++;
      const lc = selected[i];
      if (!lc) continue;
      const r = await runCase(suite, lc, suite.cases.indexOf(lc), opts, factory);
      results[i] = r;
      opts.onCase?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  const dry = opts.dry === true;
  const gates = suite.manifest.gates;
  return {
    suite: {
      name: suite.manifest.name,
      ...(suite.manifest.description ? { description: suite.manifest.description } : {}),
      dir: suite.dir,
      gates,
      dry,
    },
    cases: results,
    summary: summarize(results, { gates, dry }),
  };
}

/** Load a suite directory and run it. */
export async function runSuite(suiteDir: string, opts: RunSuiteOptions = {}): Promise<SuiteResult> {
  return runLoadedSuite(await loadSuite(suiteDir), opts);
}
