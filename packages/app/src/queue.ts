/**
 * In-process worker over the durable `jobs` table.
 *
 * - Polls with up to `concurrency` jobs in flight; never two jobs for the same PR at once.
 * - Retries GateError `source` / `internal` / `store-conflict` (and unclassified errors such as GitHub 5xx) with
 *   exponential backoff, at most `maxRetries` times. `seating` / `policy` / `budget` fail at once (a retry cannot fix
 *   configuration). `head-moved` ends `superseded`: the newer push has its own job.
 * - A minute `tick` re-evaluates installation ceilings (alerts), prunes old deliveries and jobs, compacts the ledger.
 * - `stop(deadlineMs)` stops claiming and waits for running jobs up to the deadline. Jobs still running at the
 *   deadline stay `running` in the table and are re-queued at the next boot (`requeueInterrupted`).
 */
import type { AppDb, JobRow } from "./db.js";
import { gateErrorCode } from "./gate.js";
import { type AppLogger, errText, type SecretSet } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export type JobRunner = (job: JobRow) => Promise<{ outcome: string }>;

export interface WorkerOptions {
  db: AppDb;
  run: JobRunner;
  logger: AppLogger;
  secrets: SecretSet;
  metrics: MetricsRegistry;
  concurrency?: number;
  pollMs?: number;
  /** First retry delay; doubled per attempt. Default 30 s. */
  backoffBaseMs?: number;
  maxRetries?: number;
  tickMs?: number;
  onTick?: () => Promise<void>;
  /** Called once per job after it settles (alerts after spend changed). */
  afterJob?: (job: JobRow) => Promise<void>;
  /** Called when a job fails for good, to put a failure on the check run. */
  onFinalFailure?: (job: JobRow, message: string) => Promise<void>;
}

export type Classification = "retry" | "fail" | "superseded";

export function classifyError(err: unknown): Classification {
  const code = gateErrorCode(err);
  switch (code) {
    case "seating":
    case "policy":
    case "budget":
      return "fail";
    case "head-moved":
      return "superseded";
    case "source":
    case "internal":
    case "store-conflict":
      return "retry";
    default:
      break;
  }
  const status = statusOf(err);
  if (status === 403) return isRateLimited(err) ? "retry" : "fail"; // permissions / suspended installation
  // Other 4xx from GitHub (except 429) will not get better by retrying.
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) return "fail";
  return "retry";
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  const s = (err as { status: unknown }).status;
  return typeof s === "number" ? s : undefined;
}

function headersOf(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null || !("response" in err)) return {};
  const r = (err as { response: unknown }).response;
  if (typeof r !== "object" || r === null || !("headers" in r)) return {};
  const h = (r as { headers: unknown }).headers;
  return typeof h === "object" && h !== null ? (h as Record<string, unknown>) : {};
}

/** A 403 that is really rate limiting: x-ratelimit-remaining 0, a retry-after header, or the secondary limit text. */
export function isRateLimited(err: unknown): boolean {
  const h = headersOf(err);
  if (String(h["x-ratelimit-remaining"] ?? "") === "0") return true;
  if (h["retry-after"] !== undefined) return true;
  const msg = err instanceof Error ? err.message : "";
  return /secondary rate limit|rate limit exceeded|abuse detection/i.test(msg);
}

/** Delay GitHub asked for (retry-after seconds, or until x-ratelimit-reset), capped at 15 minutes. */
export function retryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const h = headersOf(err);
  const ra = Number(h["retry-after"]);
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 15 * 60_000);
  if (String(h["x-ratelimit-remaining"] ?? "") === "0") {
    const reset = Number(h["x-ratelimit-reset"]);
    if (Number.isFinite(reset)) return Math.min(Math.max(reset * 1000 - now, 1000), 15 * 60_000);
  }
  return undefined;
}

export function backoffMs(base: number, attempt: number): number {
  return base * 2 ** Math.max(attempt - 1, 0);
}

export class Worker {
  private readonly running = new Map<number, Promise<void>>();
  private pollTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private started = false;
  private ticking = false;
  private pausedUntil = 0;
  private pumpFailures = 0;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetries: number;
  private readonly tickMs: number;

  constructor(private readonly opts: WorkerOptions) {
    this.concurrency = opts.concurrency ?? 2;
    this.pollMs = opts.pollMs ?? 1000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.tickMs = opts.tickMs ?? 60_000;
  }

  /** Boot: recover interrupted jobs (crash-loop guarded), then start polling and ticking. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const r = this.opts.db.requeueInterrupted();
    if (r.requeued + r.superseded + r.failed.length > 0) {
      this.opts.logger.info("recovered jobs interrupted by a restart", {
        requeued: r.requeued,
        superseded: r.superseded,
        failed: r.failed.length,
      });
    }
    for (const job of r.failed) {
      this.count("failed");
      this.opts.logger.error("job crashed the service repeatedly; marked failed", {
        jobId: job.id,
        attempts: job.attempts,
      });
      this.opts
        .onFinalFailure?.(
          job,
          `the review crashed the service repeatedly (${job.attempts} attempts) and was not retried`,
        )
        .catch((err: unknown) =>
          this.opts.logger.warn("could not report the crash on the check run", { error: errText(err) }),
        );
    }
    this.pollTimer = setInterval(() => this.pump(), this.pollMs);
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    this.pump();
  }

  inFlight(): number {
    return this.running.size;
  }

  /** Claim and start as many jobs as capacity allows. Safe to call any time (the webhook calls it on enqueue). */
  pump(): void {
    if (Date.now() < this.pausedUntil) return;
    while (!this.stopping && this.running.size < this.concurrency) {
      let job: JobRow | undefined;
      try {
        job = this.opts.db.claimNext();
        this.pumpFailures = 0;
      } catch (err: unknown) {
        // SQLITE_BUSY / SQLITE_FULL etc.: back off instead of crashing the process from a timer.
        this.pumpFailures++;
        const delay = Math.min(this.pollMs * 2 ** this.pumpFailures, 30_000);
        this.pausedUntil = Date.now() + delay;
        this.opts.logger.error("could not claim a job; backing off", { error: errText(err), retryInMs: delay });
        return;
      }
      if (!job) return;
      const p = this.execute(job)
        .catch((err: unknown) =>
          this.opts.logger.error("job bookkeeping failed", { jobId: job.id, error: errText(err) }),
        )
        .finally(() => this.running.delete(job.id));
      this.running.set(job.id, p);
    }
  }

  /** Wait for every job currently in flight (tests). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tick (Slack, ledger) never overlaps the next one
    this.ticking = true;
    try {
      this.opts.db.pruneDeliveries(7 * 24 * 60 * 60 * 1000);
      this.opts.db.pruneJobs(30 * 24 * 60 * 60 * 1000);
      await this.opts.onTick?.();
    } catch (err: unknown) {
      this.opts.logger.error("tick failed", { error: errText(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const log = this.opts.logger.child({ jobId: job.id, repo: job.repo, number: job.number, attempt: job.attempts });
    const started = Date.now();
    log.info("job started", { headSha: job.head_sha || "(current head)" });
    try {
      const { outcome } = await this.opts.run(job);
      const state = this.opts.db.finishJob(job.id, "done", { outcome });
      this.count(state);
      log.info("job finished", { state, outcome, ms: Date.now() - started });
    } catch (err: unknown) {
      const message = this.opts.secrets.scrub(errText(err)).slice(0, 2000);
      const cls = classifyError(err);
      const current = this.opts.db.getJob(job.id);
      if (current?.superseded_by != null || cls === "superseded") {
        this.opts.db.supersedeJob(job.id, message);
        this.count("superseded");
        log.info("job superseded", { error: message });
      } else if (cls === "retry" && job.attempts <= this.maxRetries && !this.stopping) {
        const delay = retryAfterMs(err) ?? backoffMs(this.backoffBaseMs, job.attempts);
        this.opts.db.retryJob(job.id, delay, message);
        this.opts.metrics.inc("merge_safely_job_retries_total", "Job attempts that will be retried");
        log.warn("job failed; will retry", { error: message, retryInMs: delay });
      } else if (cls === "retry" && this.stopping) {
        // Shutting down: put it straight back so the next boot picks it up.
        this.opts.db.retryJob(job.id, 0, message);
        log.warn("job failed during shutdown; re-queued", { error: message });
      } else {
        this.opts.db.finishJob(job.id, "failed", { error: message });
        this.count("failed");
        log.error("job failed", { error: message, classification: cls });
        try {
          await this.opts.onFinalFailure?.(job, message);
        } catch (reportErr: unknown) {
          log.warn("could not report the failure on the check run", {
            error: this.opts.secrets.scrub(errText(reportErr)),
          });
        }
      }
    }
    try {
      await this.opts.afterJob?.(job);
    } catch (err: unknown) {
      log.warn("after-job hook failed", { error: errText(err) });
    }
    if (!this.stopping) setImmediate(() => this.pump());
  }

  private count(state: string): void {
    this.opts.metrics.inc("merge_safely_jobs_finished_total", "Jobs finished since start, by final state", { state });
  }

  /** Stop claiming; wait for running jobs up to `deadlineMs`. Returns the number still running at the deadline. */
  async stop(deadlineMs = 30_000): Promise<number> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.running.size === 0) return 0;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), deadlineMs);
    });
    await Promise.race([Promise.allSettled([...this.running.values()]), deadline]);
    if (timer) clearTimeout(timer);
    const left = this.running.size;
    if (left > 0)
      this.opts.logger.warn("shutdown deadline reached; jobs will be re-queued at next boot", { running: left });
    return left;
  }
}
