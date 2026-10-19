/**
 * The gate as the CLI sees it. Commands only talk to `CliGate`; `gate.ts` is the single module that wires the
 * real `createGate` from @merge-safely/core, so tests inject a fake through `GateFactory` and never construct
 * real providers.
 */
import type {
  CeilingKind,
  Change,
  ChangeRef,
  Connection,
  DowngradeStep,
  HumanDigest,
  Logger,
  Principal,
  RepoRef,
  Tier,
  UntrustedText,
  Verdict,
} from "@merge-safely/core";
import type { HomePaths } from "./home.js";
import type { LoadedPolicy } from "./policy.js";
import type { TokenIdentity } from "./token.js";

export type Outcome = "pass" | "block" | "pending" | "contested" | "error" | "budget-blocked";

export interface CliReviewResult {
  outcome: Outcome;
  digest: HumanDigest;
  verdict?: Verdict;
  tier?: Tier;
  /** Error or budget reason, when the outcome is "error" / "budget-blocked". */
  reason?: string;
}

export interface CliEstimateSeat {
  id: string;
  role: "hunter" | "judge";
  lens: string;
  connectionId: string;
  provider: string;
  model: string;
  usd?: number;
  downgradedFrom?: string;
}

export interface CliCeiling {
  ceiling: string;
  limitUsd: number | null;
  currentUsd: number;
  projectedUsd: number;
  breached: boolean;
  advisory?: boolean;
}

export interface CliEstimate {
  tier: Tier;
  /** Set when triage would auto-pass without seating anyone. */
  triaged?: { reason: string };
  seats: CliEstimateSeat[];
  usd?: number;
  unknownSeats: string[];
  ceilings: CliCeiling[];
  admitted: boolean;
  /** Why admission would refuse (the binding ceiling), when it would. */
  blockedReason?: string;
  downgrades: DowngradeStep[];
  warnings: string[];
}

export interface HumanVerdictInput {
  ref: ChangeRef;
  headSha: string;
  decision: "pass" | "block";
  signedBy: Principal;
  reason: string;
}

export interface LocalReviewInput {
  change: Change;
  diff: string;
  untrusted: UntrustedText;
}

export interface CliGate {
  /** `trigger` labels the run in the check run ("Review triggered by …"); default "cli". */
  review(ref: ChangeRef, opts: { headSha?: string; trigger?: string }): Promise<CliReviewResult>;
  reviewChange(input: LocalReviewInput): Promise<CliReviewResult>;
  estimate(target: ChangeRef | LocalReviewInput): Promise<CliEstimate>;
  /** Latest verdict for a change with its digest, or null when there is none. */
  explain(ref: ChangeRef): Promise<{ verdict: Verdict; digest: HumanDigest } | null>;
  recordHumanVerdict(input: HumanVerdictInput): Promise<Verdict>;
  /**
   * Cancel an in-flight review (SIGINT/SIGTERM): report an `error` event for a change that was reported pending but
   * not finished, so a check run is not left in progress, and dispose every acquired workspace. Optional for fakes.
   */
  abort?(reason: string): Promise<void>;
}

export type StoreKind = "fs" | "sqlite" | "checkrun" | "memory";
export type ReportKind = "github" | "status" | "stdout" | "json";

export interface PrTarget {
  mode: "pr";
  repo: RepoRef;
  token: string;
  tokenIdentity: TokenIdentity;
  report: ReportKind;
  store: StoreKind;
  /** Write nothing to GitHub or the store. */
  dryRun: boolean;
}

export interface LocalTarget {
  mode: "local";
  /** Repository root reviewed in place (read-only tools). */
  root: string;
}

export interface GateSetup {
  target: PrTarget | LocalTarget;
  policy: LoadedPolicy;
  connections: Connection[];
  paths: HomePaths;
  slackWebhook?: string;
  /** Seats run in parallel (GateDeps.concurrency). Unset: the CLI default (2). */
  concurrency?: number;
  /** Build the provider catalog (calls each provider's models endpoint). Default true; explain/verdict pass false. */
  catalog?: boolean;
  /** Validate connections before seating and fail fast on a dead one (`run`). Default false. */
  validateConnections?: boolean;
  /** Per-connection validation timeout. Default 15 s. */
  validateTimeoutMs?: number;
  /** Ceilings reported but never enforced (embedders that cannot see installation-wide spend). Default ["monthly"]. */
  advisoryCeilings?: CeilingKind[];
  /** Recorded on every verdict. Default `merge-safely-cli@<version>`. */
  producedBy?: string;
  logger: Logger;
}

export type GateFactory = (setup: GateSetup) => Promise<CliGate>;

export function isChangeRef(x: ChangeRef | LocalReviewInput): x is ChangeRef {
  return "repo" in x && "number" in x && !("change" in x);
}
