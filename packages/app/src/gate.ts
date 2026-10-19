/**
 * Gate construction, behind one factory so tests inject a fake gate.
 *
 * The orchestrator (`createGate` in @merge-safely/core) is being built in parallel. Until it lands on main this module
 * mirrors its pinned API structurally and resolves `createGate` from the core namespace at call time, so the App
 * compiles today and uses the real orchestrator the moment core exports it. When it lands, replace the mirrored types
 * with `import { createGate, type GateDeps, type Gate } from "@merge-safely/core"`.
 */

import type {
  Change,
  ChangeRef,
  Clock,
  Connection,
  CostLedger,
  Escalation,
  EscalationHandle,
  HumanDigest,
  LensId,
  Logger,
  Metrics,
  ModelInfo,
  ModelProvider,
  ModelRef,
  Policy,
  Principal,
  ReportEvent,
  Reporter,
  ReviewerInput,
  SourceProvider,
  TokenUsage,
  ToolExecutorFactory,
  TrustProvider,
  Verdict,
  VerdictStore,
  Workspace,
} from "@merge-safely/core";
import * as core from "@merge-safely/core";

export interface PromptBuildOptions {
  persona?: string;
  toolsDescription?: string;
  maxRounds?: number;
  deltaSinceSha?: string;
}

export interface PromptBuilders {
  hunter(
    lens: LensId,
    input: Omit<ReviewerInput, "prompt">,
    opts?: PromptBuildOptions,
  ): { system: string; user: string };
  judge(input: Omit<ReviewerInput, "prompt">, opts?: PromptBuildOptions): { system: string; user: string };
}

export interface Pricing {
  withPricing(model: ModelInfo): ModelInfo;
  price(model: ModelInfo, usage: TokenUsage): { usd: number; estimated: boolean };
  cheaper(model: ModelRef, catalog: ModelInfo[]): ModelRef | undefined;
  normalise?(id: string): string;
}

export interface GateDeps {
  source?: SourceProvider;
  workspace: Workspace;
  providers: (conn: Connection) => ModelProvider;
  connections: Connection[];
  catalog: (connectionId: string) => ModelInfo[];
  store: VerdictStore;
  reporters: Reporter[];
  ledger?: CostLedger;
  trust?: TrustProvider;
  escalation?: Escalation;
  metrics?: Metrics;
  policy: Policy;
  policyHash?: string;
  tools: ToolExecutorFactory;
  prompts: PromptBuilders;
  pricing: Pricing;
  installationId?: string;
  advisoryCeilings?: core.CeilingKind[];
  clock?: Clock;
  logger?: Logger;
  producedBy?: string;
  concurrency?: number;
}

export interface ReviewResult {
  verdict: Verdict;
  digest: HumanDigest;
  escalation?: EscalationHandle;
  events?: ReportEvent[];
  contested?: boolean;
}

export interface HumanVerdictInput {
  ref: ChangeRef;
  headSha: string;
  decision: "pass" | "block";
  signedBy: Principal;
  reason: string;
}

export interface Gate {
  review(ref: ChangeRef, opts?: { headSha?: string; trigger?: string }): Promise<ReviewResult>;
  reviewChange?(change: Change, ctx: { diff: string }, opts?: { trigger?: string }): Promise<ReviewResult>;
  estimate?(target: ChangeRef | Change): Promise<unknown>;
  explain(ref: ChangeRef): Promise<{ verdict: Verdict | null; digest: HumanDigest | null; history: Verdict[] }>;
  recordHumanVerdict(input: HumanVerdictInput): Promise<Verdict>;
}

export type GateFactory = (deps: GateDeps) => Gate;

/** GateError codes (mirrors core's `GateErrorCode`). */
export type GateErrorCode = "head-moved" | "seating" | "budget" | "store-conflict" | "source" | "policy" | "internal";

const CODES: readonly string[] = ["head-moved", "seating", "budget", "store-conflict", "source", "policy", "internal"];

/** Structural check, so it works before and after core exports the class (and across module copies). */
export function gateErrorCode(err: unknown): GateErrorCode | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === "SeatingError") return "seating";
  if (e.name !== "GateError" || typeof e.code !== "string") return undefined;
  return CODES.includes(e.code) ? (e.code as GateErrorCode) : undefined;
}

export class GateUnavailableError extends Error {
  constructor() {
    super("the review orchestrator (createGate) is not available in this build of @merge-safely/core");
    this.name = "GateUnavailableError";
  }
}

/** The production factory: core's `createGate`. */
export const defaultGateFactory: GateFactory = (deps) => {
  const createGate = (core as Record<string, unknown>).createGate;
  if (typeof createGate !== "function") throw new GateUnavailableError();
  return (createGate as (d: GateDeps) => Gate)(deps);
};
