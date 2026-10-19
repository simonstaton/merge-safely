import type {
  Clock,
  Escalation,
  EscalationHandle,
  HumanDigest,
  Logger,
  MetricEvent,
  Metrics,
  Principal,
  RepoRef,
  ReportEvent,
  Reporter,
  TrustClass,
  TrustProvider,
  Verdict,
} from "@merge-safely/core";

export interface MemoryReporter extends Reporter {
  readonly events: ReportEvent[];
  ofType<T extends ReportEvent["type"]>(type: T): Extract<ReportEvent, { type: T }>[];
  last(): ReportEvent | undefined;
  clear(): void;
}

export function memoryReporter(): MemoryReporter {
  const events: ReportEvent[] = [];
  return {
    events,
    async report(event) {
      events.push(event);
    },
    ofType<T extends ReportEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<ReportEvent, { type: T }> => e.type === type);
    },
    last: () => events[events.length - 1],
    clear: () => {
      events.length = 0;
    },
  };
}

export interface MemoryEscalation extends Escalation {
  readonly requests: Array<{ verdict: Verdict; digest: HumanDigest; handle: EscalationHandle }>;
  /** Record a human verdict for a handle; `resolve()` returns it from then on. */
  sign(handleId: string, verdict: Verdict): void;
  resolve(handle: EscalationHandle): Promise<Verdict | null>;
}

export function memoryEscalation(opts: { now?: () => Date } = {}): MemoryEscalation {
  const requests: MemoryEscalation["requests"] = [];
  const signed = new Map<string, Verdict>();
  const now = opts.now ?? (() => new Date());
  return {
    requests,
    async request(verdict, digest) {
      const id = `esc-${requests.length + 1}`;
      const handle: EscalationHandle = { id, url: `https://escalation.example/${id}`, createdAt: now().toISOString() };
      requests.push({ verdict, digest, handle });
      return handle;
    },
    sign(handleId, verdict) {
      signed.set(handleId, verdict);
    },
    async resolve(handle) {
      return signed.get(handle.id) ?? null;
    },
  };
}

export interface MemoryMetrics extends Metrics {
  readonly events: MetricEvent[];
  named(name: string): MetricEvent[];
  sum(name: string): number;
}

export function memoryMetrics(): MemoryMetrics {
  const events: MetricEvent[] = [];
  return {
    events,
    emit: (m) => {
      events.push(m);
    },
    named: (name) => events.filter((e) => e.name === name),
    sum: (name) => events.filter((e) => e.name === name).reduce((n, e) => n + e.value, 0),
  };
}

export interface MemoryTrust extends TrustProvider {
  readonly calls: Array<{ author: Principal; repo: RepoRef }>;
}

/** Trust by login; anyone not in the map is `fallback` (default "standard"). */
export function memoryTrust(map: Record<string, TrustClass> = {}, fallback: TrustClass = "standard"): MemoryTrust {
  const calls: MemoryTrust["calls"] = [];
  return {
    calls,
    async classify(author, repo) {
      calls.push({ author, repo });
      return Object.hasOwn(map, author.login) ? (map[author.login] as TrustClass) : fallback;
    },
  };
}

export interface FixedClock extends Clock {
  advance(ms: number): void;
  set(iso: string): void;
}

/** A clock that only moves when told to. */
export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): FixedClock {
  let t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`fixedClock: not an ISO date: ${iso}`);
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    set: (next) => {
      const v = Date.parse(next);
      if (Number.isNaN(v)) throw new Error(`fixedClock: not an ISO date: ${next}`);
      t = v;
    },
  };
}

export interface SilentLogger extends Logger {
  readonly entries: Array<{ level: "debug" | "info" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }>;
}

/** A logger that prints nothing and keeps every entry for assertions. */
export function silentLogger(): SilentLogger {
  const entries: SilentLogger["entries"] = [];
  const at =
    (level: SilentLogger["entries"][number]["level"]) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      entries.push({ level, msg, ...(meta ? { meta } : {}) });
    };
  return { entries, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
