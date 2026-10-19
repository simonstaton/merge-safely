/**
 * Minimal local fakes for the orchestrator tests. Core tests may not import other packages, so these are written
 * here: a scriptable provider whose runner streams usage, an in-memory source, a temp-dir workspace, an in-memory
 * CAS store and ledger, and collecting reporter / escalation / metrics.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate } from "../../src/orchestrator/gate.js";
import type { Gate, GateDeps, Pricing, PromptBuilders } from "../../src/orchestrator/types.js";
import type { Policy } from "../../src/policy/schema.js";
import type {
  Clock,
  CostLedger,
  Escalation,
  Metrics,
  ModelProvider,
  ModelRunner,
  Reporter,
  RunnerOptions,
  SourceProvider,
  ToolExecutor,
  ToolExecutorFactory,
  ToolExecutorOptions,
  TrustProvider,
  VerdictStore,
  Workspace,
  WorkspaceHandle,
} from "../../src/ports.js";
import { makeChange } from "../../src/stages/test-helpers.js";
import type {
  Change,
  ChangeRef,
  Connection,
  CostEntry,
  EscalationHandle,
  HumanDigest,
  JudgeOutput,
  MetricEvent,
  ModelInfo,
  ModelRef,
  ModelTierClass,
  Principal,
  RepoRef,
  ReportEvent,
  ReviewerInput,
  ReviewerOutput,
  ReviewerRun,
  RunStatus,
  Seat,
  SpendSummary,
  TokenUsage,
  ToolUseAudit,
  TrustClass,
  Verdict,
  VerdictKey,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Models and connections
// ---------------------------------------------------------------------------

export const API_KEY = "sk-ant-api03-supersecretvalue1234567890abcdef";
export const BACKUP_KEY = "sk-proj-backupsecretvalue0987654321zyxw";

export const MAIN: Connection = {
  id: "main",
  provider: "anthropic",
  kind: "api-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: API_KEY },
};

export const BACKUP: Connection = {
  id: "backup",
  provider: "openai",
  kind: "api-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: BACKUP_KEY },
};

const model = (
  provider: string,
  name: string,
  tier: ModelTierClass,
  inPerMTok: number,
  outPerMTok: number,
): ModelInfo => ({
  provider,
  name,
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 200_000,
  maxOutputTokens: 32_000,
  tier,
  pricing: { inPerMTok, outPerMTok },
});

export const CATALOG: Record<string, ModelInfo[]> = {
  main: [
    model("anthropic", "opus-x", "frontier", 15, 75),
    model("anthropic", "sonnet-x", "mid", 3, 15),
    model("anthropic", "haiku-x", "small", 1, 5),
  ],
  backup: [model("openai", "gpt-big", "frontier", 30, 120), model("openai", "gpt-x", "mid", 2, 8)],
};

const TIER_RANK: Record<ModelTierClass, number> = { small: 0, mid: 1, frontier: 2 };

export const fakePricing: Pricing = {
  withPricing: (m) => (m.pricing || m.zeroCost ? m : { ...m, pricing: { inPerMTok: 20, outPerMTok: 80 } }),
  price: (m, u) => {
    if (m.zeroCost) return { usd: 0, estimated: false };
    const p = m.pricing ?? { inPerMTok: 20, outPerMTok: 80 };
    return { usd: (u.in * p.inPerMTok + u.out * p.outPerMTok) / 1_000_000, estimated: m.pricing === undefined };
  },
  cheaper: (ref, catalog) => {
    const cur = catalog.find((m) => m.name === ref.name);
    if (!cur) return undefined;
    const lower = catalog
      .filter((m) => TIER_RANK[m.tier] < TIER_RANK[cur.tier])
      .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
    return lower ? { connectionId: ref.connectionId, provider: ref.provider, name: lower.name } : undefined;
  },
};

// ---------------------------------------------------------------------------
// Scriptable provider
// ---------------------------------------------------------------------------

export interface ScriptCall {
  seat: Seat;
  input: ReviewerInput;
  connectionId: string;
  model: string;
  ws: WorkspaceHandle;
  signal?: AbortSignal;
  runnerOptions?: RunnerOptions;
}

export interface ScriptResult {
  status?: RunStatus;
  output?: ReviewerOutput | null;
  judgeOutput?: JudgeOutput | null;
  audit?: Partial<ToolUseAudit>;
  error?: string;
  /** Usage deltas streamed through onUsage before the run returns. Default one delta of 1000 in / 100 out. */
  usage?: Array<{ tokens: TokenUsage; usd?: number }>;
}

export type Script = (call: ScriptCall) => ScriptResult | Error | Promise<ScriptResult | Error>;

export const passOutput = (extra: Partial<ReviewerOutput> = {}): ReviewerOutput => ({
  verdict: "pass",
  summary: "Looks fine.",
  findings: [],
  ...extra,
});

export const defaultScript: Script = (call) =>
  call.seat.role === "judge" ? { judgeOutput: { votes: [] } } : { output: passOutput() };

export class FakeProvider implements ModelProvider {
  readonly connectionKinds = ["api-key" as const];
  readonly calls: ScriptCall[] = [];
  readonly runners: Array<{ connectionId: string; model: ModelInfo }> = [];
  script: Script;

  constructor(
    readonly id: string,
    script: Script = defaultScript,
  ) {
    this.script = script;
  }

  async validate() {
    return { ok: true };
  }

  async models(conn: Connection) {
    return CATALOG[conn.id] ?? [];
  }

  createRunner(conn: Connection, info: ModelInfo, opts?: RunnerOptions): ModelRunner {
    this.runners.push({ connectionId: conn.id, model: info });
    return {
      run: async (seat, input, ws, signal): Promise<ReviewerRun> => {
        const call: ScriptCall = { seat, input, connectionId: conn.id, model: info.name, ws };
        if (signal) call.signal = signal;
        if (opts) call.runnerOptions = opts;
        this.calls.push(call);
        const r = await this.script(call);
        if (r instanceof Error) throw r;
        for (const u of r.usage ?? [{ tokens: { in: 1000, out: 100 } }]) opts?.onUsage?.(u);
        const run: ReviewerRun = {
          seat,
          headSha: ws.headSha,
          round: input.round,
          output: r.output === undefined ? (seat.role === "judge" ? null : passOutput()) : r.output,
          audit: {
            substantiveCalls: 5,
            totalCalls: 6,
            filesRead: ["src/lib/f1.ts"],
            commandsRun: [],
            tokens: { in: 1000, out: 100 },
            wallMs: 1000,
            turns: 3,
            ...(r.audit ?? {}),
          },
          status: r.status ?? "ok",
          startedAt: "2026-06-01T00:00:00.000Z",
          finishedAt: "2026-06-01T00:01:00.000Z",
        };
        if (seat.role === "judge") run.judgeOutput = r.judgeOutput === undefined ? { votes: [] } : r.judgeOutput;
        if (r.error !== undefined) run.error = r.error;
        return run;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Source, workspace, tools
// ---------------------------------------------------------------------------

export class FakeSource implements SourceProvider {
  readonly diffCalls: Array<{ sinceSha?: string; headSha?: string }> = [];
  constructor(
    public change: Change,
    public diffs: { full: string; delta?: string } = { full: "diff --git a/x b/x\n+x" },
    public untrusted?: { commitMessages: string[]; comments: string[] },
  ) {}

  async getChange(_ref: ChangeRef): Promise<Change> {
    return structuredClone(this.change);
  }

  async getDiff(_ref: ChangeRef, opts: { sinceSha?: string; headSha?: string } = {}): Promise<string> {
    this.diffCalls.push({ ...opts });
    return opts.sinceSha ? (this.diffs.delta ?? this.diffs.full) : this.diffs.full;
  }

  async getUntrustedContext(_ref: ChangeRef) {
    return this.untrusted ?? { commitMessages: [], comments: [] };
  }
}

export class TempWorkspace implements Workspace {
  /** Override what the handle reports, to simulate a wrong checkout or a dirty tree. */
  handleOverride: { headSha?: string; dirty?: boolean } = {};
  /** Never resolve acquire (simulates a hung sandbox). */
  hang = false;
  acquired = 0;
  disposed = 0;
  readonly seatIds: string[] = [];
  readonly dirs: string[] = [];

  async acquire(change: Change, opts?: { seatId?: string }): Promise<WorkspaceHandle> {
    if (this.hang) return new Promise<WorkspaceHandle>(() => {});
    const cwd = await mkdtemp(join(tmpdir(), "ms-orch-"));
    this.acquired++;
    this.dirs.push(cwd);
    if (opts?.seatId) this.seatIds.push(opts.seatId);
    const handle: WorkspaceHandle = {
      cwd,
      headSha: this.handleOverride.headSha ?? change.headSha,
      baseSha: change.baseSha,
      dispose: async () => {
        this.disposed++;
        await rm(cwd, { recursive: true, force: true });
      },
    };
    if (this.handleOverride.dirty !== undefined) handle.dirty = this.handleOverride.dirty;
    return handle;
  }
}

export function fakeTools(record?: ToolExecutorOptions[]): ToolExecutorFactory {
  return (_ws, opts) => {
    if (record && opts) record.push(opts);
    const executor: ToolExecutor = {
      definitions: () => [
        { name: "read_file", description: "Read a file. Paged.", inputSchema: {}, substantive: true },
        { name: "grep", description: "Search files.", inputSchema: {}, substantive: true },
      ],
      execute: async () => ({ ok: true, output: "" }),
      audit: () => ({ substantiveCalls: 0, totalCalls: 0, filesRead: [], commandsRun: [] }),
    };
    return executor;
  };
}

export const fakePrompts: PromptBuilders = {
  hunter: (lens, input, opts) => ({
    system: `hunter:${lens}${opts?.toolsDescription ? `\n${opts.toolsDescription}` : ""}`,
    user: `round ${input.round}${opts?.deltaSinceSha ? ` since ${opts.deltaSinceSha}` : ""}\n${input.diff}`,
  }),
  judge: (input) => ({
    system: "judge",
    user: `candidates ${(input.candidateFindings ?? []).map((f) => f.id).join(",")}`,
  }),
};

// ---------------------------------------------------------------------------
// Store, ledger, reporters, escalation, metrics, trust, clock
// ---------------------------------------------------------------------------

const keyOf = (k: VerdictKey): string => `${k.repo.host}/${k.repo.owner}/${k.repo.name}#${k.number}@${k.headSha}`;

export class MemoryStore implements VerdictStore {
  readonly slots = new Map<string, { verdict: Verdict; version: string }>();
  private counter = 0;
  /** Number of upcoming puts to reject as version conflicts (simulates a concurrent writer). */
  conflicts = 0;
  puts = 0;
  /** Called before each put is applied; may mutate the store to simulate a concurrent writer. */
  beforePut?: (v: Verdict) => void;
  /** Never resolve get (simulates a hung database). */
  hangGet = false;

  async get(key: VerdictKey) {
    if (this.hangGet) return new Promise<null>(() => {});
    const s = this.slots.get(keyOf(key));
    return s ? { verdict: structuredClone(s.verdict), version: s.version } : null;
  }

  async put(v: Verdict, expect: { version: string | null }) {
    this.puts++;
    this.beforePut?.(v);
    const k = keyOf(v);
    const current = this.slots.get(k)?.version ?? null;
    if (this.conflicts > 0) {
      this.conflicts--;
      return { ok: false, version: current ?? "" };
    }
    if (current !== expect.version) return { ok: false, version: current ?? "" };
    this.counter++;
    const version = `v${this.counter}`;
    this.slots.set(k, { verdict: structuredClone(v), version });
    return { ok: true, version };
  }

  async listForChange(repo: RepoRef, number: number) {
    const prefix = `${repo.host}/${repo.owner}/${repo.name}#${number}@`;
    return [...this.slots.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, s]) => structuredClone(s.verdict))
      .sort((a, b) => a.round - b.round);
  }

  /** Seed a verdict directly. */
  seed(v: Verdict): void {
    this.counter++;
    this.slots.set(keyOf(v), { verdict: structuredClone(v), version: `v${this.counter}` });
  }
}

export class MemoryLedger implements CostLedger {
  readonly rows: CostEntry[] = [];
  /** Never resolve append (simulates a hung ledger). */
  hangAppend = false;
  constructor(private readonly clock: Clock) {}

  async append(entry: CostEntry): Promise<void> {
    if (this.hangAppend) return new Promise<void>(() => {});
    this.rows.push(structuredClone(entry));
  }

  private sum(rows: CostEntry[]): SpendSummary {
    const tokens = { in: 0, out: 0 };
    let usd = 0;
    for (const r of rows) {
      usd += r.usd;
      tokens.in += r.tokens.in;
      tokens.out += r.tokens.out;
    }
    return { usd, tokens, entries: rows.length };
  }

  async forChange(repo: RepoRef, number: number) {
    return this.sum(
      this.rows.filter((r) => r.repo.owner === repo.owner && r.repo.name === repo.name && r.number === number),
    );
  }

  async forWindow(installationId: string, windowMs: number) {
    const from = this.clock.now().getTime() - windowMs;
    return this.sum(this.rows.filter((r) => r.installationId === installationId && Date.parse(r.at) >= from));
  }

  async allTime(installationId: string) {
    return this.sum(this.rows.filter((r) => r.installationId === installationId));
  }
}

export class CollectingReporter implements Reporter {
  readonly events: ReportEvent[] = [];
  async report(event: ReportEvent): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

export class HangingReporter implements Reporter {
  calls = 0;
  report(): Promise<void> {
    this.calls++;
    return new Promise<void>(() => {});
  }
}

export class ThrowingReporter implements Reporter {
  calls = 0;
  async report(): Promise<void> {
    this.calls++;
    throw new Error(`reporter exploded with ${API_KEY}`);
  }
}

export class FakeEscalation implements Escalation {
  readonly requests: Array<{ verdict: Verdict; digest: HumanDigest }> = [];
  mode: "ok" | "throw" | "hang" = "ok";
  async request(verdict: Verdict, digest: HumanDigest): Promise<EscalationHandle> {
    this.requests.push({ verdict: structuredClone(verdict), digest });
    if (this.mode === "throw") throw new Error(`escalation webhook rejected ${API_KEY}`);
    if (this.mode === "hang") return new Promise<EscalationHandle>(() => {});
    return { id: `esc-${this.requests.length}`, createdAt: "2026-06-01T00:00:00.000Z" };
  }
}

export class CollectingMetrics implements Metrics {
  readonly events: MetricEvent[] = [];
  emit(m: MetricEvent): void {
    this.events.push(m);
  }
  named(name: string): MetricEvent[] {
    return this.events.filter((e) => e.name === name);
  }
}

export class FakeTrust implements TrustProvider {
  constructor(private readonly cls: TrustClass) {}
  async classify(_author: Principal, _repo: RepoRef): Promise<TrustClass> {
    return this.cls;
  }
}

/** A clock that advances 1ms per read, so ordering is deterministic and wall times are non-zero. */
export function steppingClock(start = Date.parse("2026-06-01T12:00:00.000Z")): Clock {
  let t = start;
  return { now: () => new Date(t++) };
}

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

/** A tier 1 change: 10 files x 20 lines in one module, no critical paths. */
export function tier1Change(overrides: Partial<Change> = {}): Change {
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `src/lib/f${i + 1}.ts`,
    status: "modified" as const,
    additions: 20,
    deletions: 0,
    patch: "@@ -1 +1 @@\n+const x = 1;",
  }));
  return makeChange({ files, headSha: SHA_A, ...overrides });
}

/** A tier 3 change: touches a critical path. */
export function tier3Change(overrides: Partial<Change> = {}): Change {
  const c = tier1Change(overrides);
  const files = [...c.files, { path: "src/auth/login.ts", status: "modified" as const, additions: 5, deletions: 1 }];
  return { ...c, files, stats: { ...c.stats, files: files.length, additions: c.stats.additions + 5, deletions: 1 } };
}

export function docsChange(overrides: Partial<Change> = {}): Change {
  return makeChange({ files: ["README.md", "docs/guide.md"], headSha: SHA_A, ...overrides });
}

export interface Harness {
  gate: Gate;
  deps: GateDeps;
  provider: FakeProvider;
  backupProvider: FakeProvider;
  source: FakeSource;
  workspace: TempWorkspace;
  store: MemoryStore;
  ledger: MemoryLedger;
  reporter: CollectingReporter;
  escalation: FakeEscalation;
  metrics: CollectingMetrics;
  clock: Clock;
  toolOptions: ToolExecutorOptions[];
  ref: ChangeRef;
}

export function makeHarness(opts: {
  policy: Policy;
  change?: Change;
  diffs?: { full: string; delta?: string };
  script?: Script;
  backupScript?: Script;
  connections?: Connection[];
  deps?: Partial<GateDeps>;
}): Harness {
  const clock = steppingClock();
  const change = opts.change ?? tier1Change();
  const provider = new FakeProvider("anthropic", opts.script);
  const backupProvider = new FakeProvider("openai", opts.backupScript ?? opts.script);
  const source = new FakeSource(change, opts.diffs);
  const workspace = new TempWorkspace();
  const store = new MemoryStore();
  const ledger = new MemoryLedger(clock);
  const reporter = new CollectingReporter();
  const escalation = new FakeEscalation();
  const metrics = new CollectingMetrics();
  const toolOptions: ToolExecutorOptions[] = [];
  const connections = opts.connections ?? [MAIN];
  const deps: GateDeps = {
    source,
    workspace,
    providers: (conn) => (conn.id === "backup" ? backupProvider : provider),
    connections,
    catalog: (id) => CATALOG[id] ?? [],
    store,
    reporters: [reporter],
    ledger,
    escalation,
    metrics,
    policy: opts.policy,
    tools: fakeTools(toolOptions),
    prompts: fakePrompts,
    pricing: fakePricing,
    installationId: "inst-1",
    clock,
    ...(opts.deps ?? {}),
  };
  return {
    gate: createGate(deps),
    deps,
    provider,
    backupProvider,
    source,
    workspace,
    store,
    ledger,
    reporter,
    escalation,
    metrics,
    clock,
    toolOptions,
    ref: { repo: change.repo, number: change.number },
  };
}

/** The model ref a seat ran on, for assertions. */
export const refName = (r: ModelRef | undefined): string | undefined => (r ? `${r.connectionId}/${r.name}` : undefined);
