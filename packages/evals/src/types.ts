/** Result types shared by the runner, scoring and reports. */
import type { Decision, Severity, TierLevel } from "@merge-safely/core";
import type { SuiteSummary } from "./report.js";
import type { CaseExpected, CaseKind, SuiteGates } from "./suite.js";

export interface ActualFinding {
  class: string;
  severity: Severity;
  file?: string;
  line?: number;
  /** First lens that raised it (see `lenses` for all). */
  lens?: string;
  lenses: string[];
  /** Model names of the hunter seats whose lens raised it. */
  models: string[];
}

export type CaseStatus = "ok" | "dry" | "error";

export interface CaseActual {
  /** "not-run" in dry mode when the change would go to a panel. */
  decision: Decision | "not-run";
  tier?: TierLevel;
  /** Human-readable tiering reasons from the core tier stage. */
  tierReasons?: string[];
  triage?: "auto-pass" | "review";
  triageReason?: string;
  findings: ActualFinding[];
  cost: { usd?: number; estimateUsd?: number };
  /** Number of seats (reviewer runs in full mode, planned seats in dry mode). */
  seats: number;
  /** Lens of each hunter seat. */
  lenses: string[];
  /** Distinct model names that served (or would serve) a seat. */
  models: string[];
  status: CaseStatus;
  /** Set when the verdict was contested (a stored unresolved block for this SHA). Counts as unresolved. */
  contested?: boolean;
  /** Why the gate could not decide this run, when it says so. */
  pendingReason?: string;
  error?: string;
  /** Seat runs that did not finish ok, e.g. "hunter:perf:1=timeout". */
  seatFailures?: string[];
}

export interface CaseResult {
  id: string;
  title: string;
  kind: CaseKind;
  expected: CaseExpected;
  actual: CaseActual;
  passed: boolean;
  reasons: string[];
  durationMs: number;
}

export interface SuiteResult {
  suite: { name: string; description?: string; dir: string; gates: SuiteGates; dry: boolean };
  cases: CaseResult[];
  summary: SuiteSummary;
}
