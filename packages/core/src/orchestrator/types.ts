import type { CeilingKind, CeilingResult } from "../budget/ceilings.js";
import type { Policy } from "../policy/schema.js";
import type {
  Clock,
  CostLedger,
  Escalation,
  Logger,
  Metrics,
  ModelProvider,
  Reporter,
  SourceProvider,
  ToolExecutorFactory,
  TrustProvider,
  VerdictStore,
  Workspace,
} from "../ports.js";
import type { TriageResult } from "../stages/triage.js";
import type {
  Change,
  ChangeRef,
  Connection,
  EscalationHandle,
  HumanDigest,
  LensId,
  ModelInfo,
  ModelRef,
  Principal,
  ReportEvent,
  ReviewerInput,
  Seat,
  Tier,
  TokenUsage,
  Verdict,
} from "../types.js";

/** Resolve the provider adapter for a connection (usually `ProviderRegistry.forConnection`). */
export type ProviderResolver = (conn: Connection) => ModelProvider;

export interface PromptBuildOptions {
  persona?: string;
  toolsDescription?: string;
  maxRounds?: number;
  deltaSinceSha?: string;
}

/** Prompt builders, injected so core does not depend on @merge-safely/lenses. */
export interface PromptBuilders {
  hunter(
    lens: LensId,
    input: Omit<ReviewerInput, "prompt">,
    opts?: PromptBuildOptions,
  ): { system: string; user: string };
  judge(input: Omit<ReviewerInput, "prompt">, opts?: PromptBuildOptions): { system: string; user: string };
}

/** Pricing knowledge, injected so core does not depend on @merge-safely/registry. */
export interface Pricing {
  /** Fill missing pricing with the pessimistic fallback (registry `withPricing`). */
  withPricing(model: ModelInfo): ModelInfo;
  /** Dollar cost of a usage record (registry `priceUsage`). */
  price(model: ModelInfo, usage: TokenUsage): { usd: number; estimated: boolean };
  /** The next cheaper model on the same connection, for the downgrade ladder. */
  cheaper(model: ModelRef, catalog: ModelInfo[]): ModelRef | undefined;
  /** Model id normaliser for catalog lookups (registry `normaliseModelId`). */
  normalise?(id: string): string;
}

/** Context handed to a custom usage estimator. */
export interface UsageEstimateContext {
  /** Size of the diff the seat will see, in chars (estimated from change stats when the diff is not fetched). */
  diffChars: number;
  change: Change;
  secondJudgeRound: boolean;
}

export interface GateDeps {
  /** Optional: `reviewChange()` works without it. `review()`, `explain()` need it. */
  source?: SourceProvider;
  workspace: Workspace;
  providers: ProviderResolver;
  connections: Connection[];
  catalog: (connectionId: string) => ModelInfo[];
  store: VerdictStore;
  reporters: Reporter[];
  ledger?: CostLedger;
  trust?: TrustProvider;
  escalation?: Escalation;
  metrics?: Metrics;
  policy: Policy;
  /** Default `policyHash(policy)`. */
  policyHash?: string;
  tools: ToolExecutorFactory;
  prompts: PromptBuilders;
  pricing: Pricing;
  /**
   * Scope for installation-wide ceilings and ledger rows. Defaults to `<host>/<owner>/<name>` of the change's repo,
   * so the window/all-time ceilings of a single-repo deployment still have a stable key.
   */
  installationId?: string;
  /** Ceilings evaluated and reported but never blocking. The Action passes ["monthly"]. */
  advisoryCeilings?: CeilingKind[];
  clock?: Clock;
  logger?: Logger;
  /** Library version stamped on verdicts. */
  producedBy?: string;
  /** Concurrent seat runs. Default 4. */
  concurrency?: number;
  /**
   * Optional override for the per-seat token estimate used by budgets and `estimate()`. Defaults to
   * `estimateSeatUsage` (a conservative heuristic over diff size and seat role).
   */
  estimateUsage?: (seat: Seat, ctx: UsageEstimateContext) => TokenUsage;
}

export interface ReviewResult {
  verdict: Verdict;
  digest: HumanDigest;
  escalation?: EscalationHandle;
  /** Every event this call reported, in order. */
  events: ReportEvent[];
  /** True when a stored, unresolved block for this SHA prevented this round's result from replacing it. */
  contested?: boolean;
}

export interface Estimate {
  change: Change;
  tier: Tier;
  triage: TriageResult;
  seats: Seat[];
  secondJudgeRound: boolean;
  estimateUsd?: number;
  unknownSeats: string[];
  ceilings: CeilingResult[];
  round: number;
  diffOnly: boolean;
  summary: string;
}

export interface ReviewChangeContext {
  diff: string;
  /** Delta since the last reviewed SHA; used for diff-only rounds. Without it the round reviews the full diff. */
  deltaDiff?: string;
  untrusted?: { commitMessages?: string[]; comments?: string[] };
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
  /** Review a change the caller already holds (`--local` mode and tests). No source port is used. */
  reviewChange(change: Change, ctx: ReviewChangeContext, opts?: { trigger?: string }): Promise<ReviewResult>;
  /** Tier, seats and estimated cost without any model call or report. */
  estimate(target: ChangeRef | Change): Promise<Estimate>;
  explain(ref: ChangeRef): Promise<{ verdict: Verdict | null; digest: HumanDigest | null; history: Verdict[] }>;
  recordHumanVerdict(input: HumanVerdictInput): Promise<Verdict>;
}
