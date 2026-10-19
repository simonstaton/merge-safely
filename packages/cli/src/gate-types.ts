/**
 * The gate as the CLI sees it. Commands only talk to `CliGate`; `gate.ts` is the single module that wires the
 * real `createGate` from @merge-safely/core, so tests inject a fake through `GateFactory` and never construct
 * real providers.
 */
import type {
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
  review(ref: ChangeRef, opts: { headSha?: string }): Promise<CliReviewResult>;
  reviewChange(input: LocalReviewInput): Promise<CliReviewResult>;
  estimate(target: ChangeRef | LocalReviewInput): Promise<CliEstimate>;
  /** Latest verdict for a change with its digest, or null when there is none. */
  explain(ref: ChangeRef): Promise<{ verdict: Verdict; digest: HumanDigest } | null>;
  recordHumanVerdict(input: HumanVerdictInput): Promise<Verdict>;
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
  logger: Logger;
}

export type GateFactory = (setup: GateSetup) => Promise<CliGate>;

export function isChangeRef(x: ChangeRef | LocalReviewInput): x is ChangeRef {
  return "repo" in x && "number" in x && !("change" in x);
}
