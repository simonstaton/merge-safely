/**
 * Ports: everything that touches a VCS, a model, a filesystem or a network.
 * The core only ever calls these interfaces; adapters implement them.
 */
import type {
  Change,
  ChangeRef,
  Connection,
  ConnectionKind,
  CostEntry,
  EscalationHandle,
  HumanDigest,
  MetricEvent,
  ModelInfo,
  Principal,
  ProviderId,
  RepoRef,
  ReportEvent,
  ReviewerInput,
  ReviewerRun,
  Seat,
  SpendSummary,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolUseAudit,
  TrustClass,
  ValidationResult,
  Verdict,
  VerdictKey,
} from "./types.js";

export interface SourceProvider {
  getChange(ref: ChangeRef): Promise<Change>;
  /**
   * Full unified diff base...head, or the delta since `sinceSha` when given.
   * Pass `headSha` to pin the diff to the commit the verdict is bound to (the PR head may move between calls).
   */
  getDiff(ref: ChangeRef, opts?: { sinceSha?: string; headSha?: string }): Promise<string>;
  /** Commit messages and review comments on the change. Untrusted text. */
  getUntrustedContext?(ref: ChangeRef): Promise<{ commitMessages: string[]; comments: string[] }>;
  listOpenChanges?(repo: RepoRef): AsyncIterable<ChangeRef>;
}

export interface WorkspaceHandle {
  /** Absolute path of a read-only checkout of headSha. */
  cwd: string;
  headSha: string;
  baseSha?: string;
  /**
   * True when cwd is a working tree with uncommitted changes (e.g. `merge-safely run --local`).
   * headSha is then "WORKTREE" and the result must not be treated as pinned to a commit.
   */
  dirty?: boolean;
  dispose(): Promise<void>;
}

export interface Workspace {
  /** Provide a read-only checkout of change.headSha. Must be disposable and isolated per seat. */
  acquire(change: Change, opts?: { seatId?: string }): Promise<WorkspaceHandle>;
}

export interface ModelProvider {
  id: ProviderId;
  connectionKinds: ConnectionKind[];
  /** Cheap health check and model list. Must never throw on a bad key: return ok: false. */
  validate(conn: Connection): Promise<ValidationResult>;
  /** Registry models filtered by what this connection can reach, extended by a runtime list when available. */
  models(conn: Connection): Promise<ModelInfo[]>;
  createRunner(conn: Connection, model: ModelInfo, opts?: RunnerOptions): ModelRunner;
}

export interface RunnerOptions {
  /** Called with each usage delta as it arrives so the ledger streams rather than estimates. */
  onUsage?: (delta: { tokens: TokenUsage; usd?: number }) => void;
  /** Called per tool execution, mostly for logging. */
  onToolCall?: (call: ToolCall, result: ToolResult) => void;
  /** Factory for the shared read-only tool set bound to a workspace. */
  tools?: ToolExecutorFactory;
  logger?: Logger;
}

export interface ModelRunner {
  /**
   * Run one seat. Must enforce the JSON schema, read-only tools and the budget,
   * and must produce the ToolUseAudit itself from what it observed.
   */
  run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun>;
}

export interface VerdictStore {
  get(key: VerdictKey): Promise<{ verdict: Verdict; version: string } | null>;
  /**
   * Compare-and-set. `expect.version` is the version returned by `get`, or null when no verdict exists.
   * A later pass must not overwrite an unresolved independent block; the core checks that before calling put.
   */
  put(v: Verdict, expect: { version: string | null }): Promise<{ ok: boolean; version: string }>;
  listForChange(repo: RepoRef, number: number): Promise<Verdict[]>;
}

export interface Reporter {
  report(event: ReportEvent): Promise<void>;
}

export interface TrustProvider {
  /** Used ONLY for bypass and escalation routing. Never changes the tier. */
  classify(author: Principal, repo: RepoRef): Promise<TrustClass>;
}

export interface Escalation {
  request(v: Verdict, digest: HumanDigest): Promise<EscalationHandle>;
  /** Human verdict, SHA-bound, or null while unresolved. */
  resolve?(handle: EscalationHandle): Promise<Verdict | null>;
}

export interface Metrics {
  emit(m: MetricEvent): void;
}

export interface CostLedger {
  append(entry: CostEntry): Promise<void>;
  /** Spend for one change across all rounds and SHAs. */
  forChange(repo: RepoRef, number: number): Promise<SpendSummary>;
  /** Spend for an installation inside a rolling window ending now. */
  forWindow(installationId: string, windowMs: number): Promise<SpendSummary>;
  /** All-time spend for an installation against this ledger (never the provider's account figure). */
  allTime(installationId: string): Promise<SpendSummary>;
  /** Reset the all-time counter; implementations may compact rows into a rollup. */
  reset?(installationId: string): Promise<void>;
}

/** The shared read-only tool set bound to one workspace. The runner executes tools; the model never does. */
export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  /** Runner-observed proof of work so far (tokens and wall time are filled by the runner). */
  audit(): Pick<ToolUseAudit, "substantiveCalls" | "totalCalls" | "filesRead" | "commandsRun">;
}

export interface ToolExecutorOptions {
  allowedCommands?: string[];
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
}

export type ToolExecutorFactory = (ws: WorkspaceHandle, opts?: ToolExecutorOptions) => ToolExecutor;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface Clock {
  now(): Date;
}
