/**
 * Domain model for Merge Safely. Plain data only: no methods, no I/O.
 * Every type here is the contract between the pure core and the adapters.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface RepoRef {
  host: string; // "github.com"
  owner: string;
  name: string;
}

export interface ChangeRef {
  repo: RepoRef;
  number: number;
}

export interface Principal {
  kind: "human" | "bot" | "agent";
  login: string;
  id?: string | number;
}

export interface TicketRef {
  provider: string; // "linear" | "jira" | "github-issue" | ...
  id: string;
  url?: string;
  title?: string;
  body?: string; // untrusted
}

// ---------------------------------------------------------------------------
// Change under review
// ---------------------------------------------------------------------------

export type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Optional unified diff hunk text for this file, when the source provider has it. */
  patch?: string;
}

export type CiStatus = "pending" | "success" | "failure" | "unknown";

export interface Change {
  repo: RepoRef;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  /** Untrusted. Only reaches prompts inside delimited data blocks. */
  title: string;
  /** Untrusted. Only reaches prompts inside delimited data blocks. */
  body: string;
  author: Principal;
  files: ChangedFile[];
  stats: { additions: number; deletions: number; files: number };
  labels: string[];
  draft: boolean;
  ciStatus: CiStatus;
  linkedTicket?: TicketRef;
  /** True when the head ref lives in a fork of the base repo. */
  fromFork?: boolean;
  url?: string;
}

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

export type TierLevel = 0 | 1 | 2 | 3;

export interface Tier {
  level: TierLevel;
  /** 0..100 composite */
  score: number;
  factors: {
    loc: number;
    files: number;
    modules: number;
    criticalPathHits: string[];
    flagRemovals?: string[];
    blastRadius?: number;
  };
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Models and connections
// ---------------------------------------------------------------------------

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openai-compatible"
  | "anthropic-compatible"
  | "bedrock"
  | "vertex"
  | "azure-openai"
  | "ollama"
  | (string & {});

export type ConnectionKind =
  | "api-key"
  | "openai-compatible"
  | "anthropic-compatible"
  | "oauth"
  | "cloud"
  | "subscription";

export type ModelTierClass = "small" | "mid" | "frontier";

export interface ModelPricing {
  inPerMTok: number;
  outPerMTok: number;
  cachedInPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface ModelInfo {
  provider: ProviderId;
  name: string;
  displayName?: string;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  /** Undefined means unknown; budgets then use the registry's pessimistic fallback. */
  pricing?: ModelPricing;
  /** Explicitly free (local, or plan-included under a subscription connection). */
  zeroCost?: boolean;
  tier: ModelTierClass;
  effortLevels?: string[];
  /** Registry version or "runtime" when discovered from a provider's models endpoint. */
  source?: string;
}

/** Non-secret connection metadata. The secret blob is held separately by the connection store. */
export interface ConnectionRecord {
  id: string;
  provider: ProviderId;
  kind: ConnectionKind;
  label?: string;
  createdBy?: string;
  createdAt: string;
  lastValidatedAt?: string;
  scopes?: string[];
  defaultModel?: string;
  /** Non-secret runner preference, e.g. { runner: "cli" } for the Claude Code CLI runner. */
  options?: Record<string, string | number | boolean>;
}

export type ConnectionSecret =
  | { kind: "api-key"; apiKey: string }
  | { kind: "openai-compatible"; baseUrl: string; apiKey?: string; headers?: Record<string, string> }
  | { kind: "anthropic-compatible"; baseUrl: string; apiKey: string; headers?: Record<string, string> }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { kind: "cloud"; region?: string; projectOrResource?: string; credentialsRef?: string }
  | { kind: "subscription"; credentialFileRef?: string };

/** A connection as handed to a provider adapter: metadata plus the decrypted secret. */
export interface Connection extends ConnectionRecord {
  secret: ConnectionSecret;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
  models?: ModelInfo[];
  latencyMs?: number;
}

export interface ModelRef {
  connectionId: string;
  provider: ProviderId;
  name: string;
  effort?: string;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export type LensId = string;
export type PersonaId = string;
export type SeatRole = "hunter" | "judge";

export interface SeatBudget {
  maxTurns: number;
  maxUsd?: number;
  deadlineMs: number;
}

export interface Seat {
  /** Stable identifier within a round, e.g. "hunter:correctness:1". */
  id: string;
  lens: LensId;
  persona?: PersonaId;
  model: ModelRef;
  role: SeatRole;
  budget: SeatBudget;
  /** Set when the seat was downgraded from a stronger model by the budget ladder. */
  downgradedFrom?: ModelRef;
}

// ---------------------------------------------------------------------------
// Findings and reviewer output
// ---------------------------------------------------------------------------

export type Severity = "blocker" | "important" | "nit" | "pre-existing";

export interface Finding {
  /** Fingerprint: hash(path, normalised line window, class). Assigned by the core, not the model. */
  id: string;
  severity: Severity;
  /** e.g. "symptom-fix", "n-plus-one", "stale-approval", "missing-flag", "lock-risk" */
  class: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  endLine?: number;
  evidence?: string[];
  suggestedFix?: string;
  /** Which lens(es) raised it. Filled during aggregation. */
  lenses?: LensId[];
  /** Judge confirmations / refutations, filled during the judge phase. */
  votes?: JudgeVote[];
}

export interface ReviewerOutput {
  verdict: "pass" | "block";
  summary: string;
  findings: Finding[];
  /** Claims in the PR body the reviewer disproved. */
  confidenceRefuted?: string[];
  /** Round >1 only: known finding ids the reviewer checked and found addressed. */
  addressed?: string[];
}

export type JudgeDecision = "confirm" | "refute" | "downgrade";

export interface JudgeVote {
  findingId: string;
  decision: JudgeDecision;
  /** Required when decision is "downgrade". */
  severity?: Severity;
  reason?: string;
  seatId?: string;
}

export interface JudgeOutput {
  votes: JudgeVote[];
  /** Judges may raise findings the hunters missed; these need a second judge to confirm. */
  newFindings?: Finding[];
  summary?: string;
}

// ---------------------------------------------------------------------------
// Runner results
// ---------------------------------------------------------------------------

export interface TokenUsage {
  in: number;
  out: number;
  cachedIn?: number;
  cacheWrite?: number;
}

/** Runner-attested proof of work. The model does not write this. */
export interface ToolUseAudit {
  substantiveCalls: number;
  totalCalls: number;
  filesRead: string[];
  commandsRun: string[];
  tokens: TokenUsage;
  costUsd?: number;
  wallMs: number;
  turns: number;
}

export type RunStatus = "ok" | "timeout" | "error" | "schema-invalid" | "budget-exceeded" | "insufficient-work";

export interface ReviewerRun {
  seat: Seat;
  headSha: string;
  round: number;
  /** Hunter output, or null if the run failed or timed out. */
  output: ReviewerOutput | null;
  /** Judge output when seat.role === "judge". */
  judgeOutput?: JudgeOutput | null;
  audit: ToolUseAudit;
  status: RunStatus;
  error?: string;
  startedAt: string;
  finishedAt: string;
  /** Set when a fallback connection served this seat. */
  fallbackUsed?: ModelRef;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Decision = "pass" | "block" | "pending";

export interface DowngradeStep {
  step: "hunters-model" | "judges-model" | "seat-count" | "block";
  from?: string;
  to?: string;
  reason: string;
}

export interface VerdictCost {
  usd?: number;
  tokens: TokenUsage;
  /** Which connection served each seat id. */
  bySeat: Record<string, { connectionId: string; model: string; usd?: number }>;
}

export interface VerdictKey {
  repo: RepoRef;
  number: number;
  headSha: string;
}

export interface Verdict extends VerdictKey {
  kind: "machine" | "human";
  decision: Decision;
  tier: Tier;
  round: number;
  /** Zero seats with triaged: true means the deterministic triage stage auto-passed it. */
  triaged: boolean;
  triageReason?: string;
  seats: ReviewerRun[];
  findings: Finding[];
  quorum: { required: number; passed: number; blocked: number; invalid: number };
  cost: VerdictCost;
  downgrades?: DowngradeStep[];
  /** Set when a stored, unresolved block for this SHA prevented a pass from overwriting it. */
  contested?: boolean;
  /** Prior finding ids addressed in this round. */
  addressed?: string[];
  /** Prior finding ids still open. */
  carried?: string[];
  escalated?: boolean;
  /** The escalation handle, recorded once `Escalation.request` succeeded; re-runs never request again. */
  escalation?: EscalationHandle;
  /** Human verdicts: who signed and why. */
  signedBy?: Principal;
  reason?: string;
  createdAt: string;
  expiresAt?: string;
  policyHash: string;
  /** Library version that produced it. */
  producedBy?: string;
}

// ---------------------------------------------------------------------------
// Reviewer input (what a seat sees)
// ---------------------------------------------------------------------------

/** Untrusted text, already redacted of secret shapes. Prompts must delimit it as data. */
export interface UntrustedText {
  title: string;
  body: string;
  commitMessages?: string[];
  comments?: string[];
  ticket?: TicketRef;
}

export interface ReviewerInput {
  change: Change;
  tier: Tier;
  round: number;
  /** Unified diff (full on round 1, delta after when policy.rounds.diffOnlyAfterRound allows). */
  diff: string;
  diffIsDelta: boolean;
  untrusted: UntrustedText;
  /** Findings from earlier rounds the reviewer must not repeat but must check for being addressed. */
  knownFindings: Finding[];
  /** Judge seats only: the hunters' candidate findings to vote on. */
  candidateFindings?: Finding[];
  /** Test/build commands the policy allows the reviewer to run, if any. */
  allowedCommands: string[];
  /** The rendered lens prompt (system) and rubric, built by the lens package. */
  prompt: { system: string; user: string };
  /** JSON schema the final message must satisfy. */
  outputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reporting, escalation, metrics, cost
// ---------------------------------------------------------------------------

export interface HumanDigest {
  headline: string;
  markdown: string;
  text: string;
}

export type ReportEvent =
  | { type: "pending"; change: Change; tier?: Tier; round: number; message?: string }
  | { type: "verdict"; change: Change; verdict: Verdict; digest: HumanDigest }
  | { type: "escalated"; change: Change; verdict: Verdict; digest: HumanDigest; handle: EscalationHandle }
  | { type: "budget-blocked"; change: Change; tier: Tier; reason: string; ceiling: string; digest: HumanDigest }
  | { type: "error"; change: Change; error: string; round: number };

export interface EscalationHandle {
  id: string;
  url?: string;
  createdAt: string;
}

export type TrustClass = "trusted" | "standard" | "blocked";

export interface MetricEvent {
  name: string;
  value: number;
  unit?: "count" | "usd" | "ms" | "tokens";
  tags: Record<string, string | number | boolean>;
  at?: string;
}

/** One streamed cost delta from a runner. Rows are append-only. */
export interface CostEntry {
  at: string;
  repo: RepoRef;
  number: number;
  headSha: string;
  round: number;
  seatId: string;
  lens: LensId;
  connectionId: string;
  provider: ProviderId;
  model: string;
  tokens: TokenUsage;
  usd: number;
  /** True when usd came from the pessimistic fallback rate. */
  estimated: boolean;
  /** Installation / repo-set scope for rolling-window and all-time ceilings. */
  installationId?: string;
}

export interface SpendSummary {
  usd: number;
  tokens: TokenUsage;
  entries: number;
}

// ---------------------------------------------------------------------------
// Shared tool contract (used by every API runner and implemented by @merge-safely/tools)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Counts toward proof of work when true (reads, greps, diffs, test runs). */
  substantive: boolean;
}

export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  truncated?: boolean;
  /** Files the call read, for the audit. */
  filesRead?: string[];
  /** Command the call ran, for the audit. */
  commandRun?: string;
}
