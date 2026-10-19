/**
 * A scripted gate for testing suites and the runner without models. Each case id maps to the verdict the gate
 * should return; `estimate` uses the real core stages unless overridden. Calls are recorded for assertions.
 */
import type {
  Change,
  Decision,
  Finding,
  Policy,
  ReviewerRun,
  Seat,
  Severity,
  TierLevel,
  Verdict,
} from "@merge-safely/core";
import { type EvalGate, estimateWithStages, type GateEstimate, type GateFactory } from "./gate.js";

export interface ScriptedFinding {
  class: string;
  lens: string;
  severity?: Severity;
  file?: string;
  line?: number;
}

export interface CaseScript {
  decision: Decision;
  findings?: ScriptedFinding[];
  /** Overrides the verdict tier (defaults to the estimated tier). */
  tier?: TierLevel;
  costUsd?: number;
  /** Model name per lens; default "scripted-model". */
  models?: Record<string, string>;
  /** Mark the verdict contested. */
  contested?: boolean;
  /** Throw this message from reviewChange. */
  throws?: string;
  /** Replace the estimate entirely. */
  estimate?: (change: Change, policy: Policy) => GateEstimate;
}

export interface ScriptedCalls {
  estimate: string[];
  review: string[];
  factory: string[];
}

function hunterSeat(lens: string, model: string, i: number): Seat {
  return {
    id: `hunter:${lens}:${i + 1}`,
    lens,
    model: { connectionId: "scripted", provider: "scripted", name: model },
    role: "hunter",
    budget: { maxTurns: 10, deadlineMs: 60_000 },
  };
}

function run(seat: Seat, change: Change, verdict: "pass" | "block"): ReviewerRun {
  return {
    seat,
    headSha: change.headSha,
    round: 1,
    output: { verdict, summary: "scripted", findings: [] },
    audit: {
      substantiveCalls: 5,
      totalCalls: 5,
      filesRead: ["x"],
      commandsRun: [],
      tokens: { in: 0, out: 0 },
      wallMs: 1,
      turns: 1,
    },
    status: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

export function scriptedVerdict(
  change: Change,
  est: GateEstimate,
  script: CaseScript,
  policyHash = "scripted",
): Verdict {
  const findings: Finding[] = (script.findings ?? []).map((f, i) => {
    const out: Finding = {
      id: `f${i}`,
      severity: f.severity ?? "blocker",
      class: f.class,
      title: f.class,
      detail: "scripted finding",
      lenses: [f.lens],
    };
    if (f.file !== undefined) out.file = f.file;
    if (f.line !== undefined) out.line = f.line;
    return out;
  });
  const triaged = est.triage?.decision === "auto-pass";
  const lenses = triaged
    ? []
    : [
        ...new Set([
          ...est.seats.filter((s) => s.role === "hunter").map((s) => s.lens),
          ...findings.flatMap((f) => f.lenses ?? []),
        ]),
      ];
  const seats = lenses.map((l, i) => {
    const raised = findings.some((f) => f.lenses?.includes(l) && f.severity === "blocker");
    return run(hunterSeat(l, script.models?.[l] ?? "scripted-model", i), change, raised ? "block" : "pass");
  });
  const tier = script.tier !== undefined ? { ...est.tier, level: script.tier } : est.tier;
  return {
    repo: change.repo,
    number: change.number,
    headSha: change.headSha,
    kind: "machine",
    decision: script.decision,
    tier,
    round: 1,
    triaged,
    ...(triaged && est.triage ? { triageReason: est.triage.reason } : {}),
    seats,
    findings,
    quorum: { required: 1, passed: seats.filter((s) => s.output?.verdict === "pass").length, blocked: 0, invalid: 0 },
    cost: { ...(script.costUsd !== undefined ? { usd: script.costUsd } : {}), tokens: { in: 0, out: 0 }, bySeat: {} },
    ...(script.contested ? { contested: true } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    policyHash,
  };
}

/** A gate factory whose gates answer from `scripts[caseId]`. Unknown case ids make reviewChange throw. */
export function scriptedGateFactory(scripts: Record<string, CaseScript>): {
  factory: GateFactory;
  calls: ScriptedCalls;
} {
  const calls: ScriptedCalls = { estimate: [], review: [], factory: [] };
  const factory: GateFactory = (policy, ctx) => {
    calls.factory.push(ctx.caseId);
    const script = scripts[ctx.caseId];
    const gate: EvalGate = {
      estimate(change) {
        calls.estimate.push(ctx.caseId);
        return script?.estimate ? script.estimate(change, policy) : estimateWithStages(change, policy);
      },
      async reviewChange(change) {
        calls.review.push(ctx.caseId);
        if (!script) throw new Error(`no script for case ${ctx.caseId}`);
        if (script.throws) throw new Error(script.throws);
        const est = script.estimate ? script.estimate(change, policy) : estimateWithStages(change, policy);
        const verdict = scriptedVerdict(change, est, script);
        return { verdict, digest: { headline: verdict.decision, markdown: "", text: "" }, events: [] };
      },
    };
    return gate;
  };
  return { factory, calls };
}
