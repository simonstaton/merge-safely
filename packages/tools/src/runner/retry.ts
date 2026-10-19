import type { Logger } from "@merge-safely/core";

/** Provider-neutral classification of a failed model call. `message` must already be safe (redacted). */
export interface ErrorInfo {
  kind: "auth" | "permission" | "rate-limit" | "server" | "network" | "bad-request" | "not-found" | "abort" | "other";
  retryable: boolean;
  status?: number;
  /** Server-requested delay (Retry-After, retry-after-ms, RetryInfo.retryDelay). */
  retryAfterMs?: number;
  message: string;
}

export type ErrorClassifier = (err: unknown) => ErrorInfo;

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: Required<RetryOptions> = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };

/** Exponential backoff with full jitter, or the server's requested delay when it gave one. */
export function backoffDelay(
  attempt: number,
  info: Pick<ErrorInfo, "retryAfterMs">,
  o: Required<RetryOptions>,
): number {
  if (info.retryAfterMs !== undefined && Number.isFinite(info.retryAfterMs) && info.retryAfterMs >= 0) {
    // Honour the server, but never wait longer than a minute for a single retry.
    return Math.min(info.retryAfterMs, 60_000);
  }
  const cap = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

/** Parse a Retry-After header value (delta-seconds or HTTP date) and/or retry-after-ms. */
export function parseRetryAfter(
  retryAfter?: string | null,
  retryAfterMs?: string | null,
  now = Date.now(),
): number | undefined {
  if (retryAfterMs) {
    const ms = Number(retryAfterMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  if (!retryAfter) return undefined;
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(retryAfter);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

export class AbortedError extends Error {
  constructor(readonly reason: unknown) {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Sleep that rejects with AbortedError as soon as the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError(signal.reason));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Race a promise against an abort signal so an SDK or tool that ignores the signal still cannot
 * hold a seat past its deadline.
 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new AbortedError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly info: ErrorInfo,
    readonly attempts: number,
  ) {
    super(`${info.message} (gave up after ${attempts} attempts)`);
    this.name = "RetriesExhaustedError";
  }
}

/** The next retry (usually a server Retry-After) would land after the seat deadline, so stop now. */
export class RetryBeyondDeadlineError extends Error {
  constructor(
    readonly info: ErrorInfo,
    readonly delayMs: number,
    readonly remainingMs: number,
  ) {
    super(
      `${info.message}; rate limited beyond the seat deadline (retry requested in ${Math.ceil(delayMs / 1000)}s, ` +
        `${Math.max(0, Math.floor(remainingMs / 1000))}s left)`,
    );
    this.name = "RetryBeyondDeadlineError";
  }
}

export class NonRetryableError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
    this.name = "NonRetryableError";
  }
}

/**
 * Run `fn`, retrying 429/5xx/network failures up to `maxRetries` times. Throws AbortedError when the
 * signal fires, NonRetryableError for permanent failures, RetriesExhaustedError when retries run out and
 * RetryBeyondDeadlineError when the next attempt could only start after `deadlineAt`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    classify: ErrorClassifier;
    signal: AbortSignal;
    retry?: RetryOptions;
    logger?: Logger;
    label?: string;
    /** Epoch ms of the caller's deadline; a retry that would land after it fails immediately instead. */
    deadlineAt?: number;
  },
): Promise<T> {
  const o = { ...DEFAULT_RETRY, ...opts.retry };
  for (let attempt = 0; ; attempt++) {
    if (opts.signal.aborted) throw new AbortedError(opts.signal.reason);
    try {
      return await abortable(fn(), opts.signal);
    } catch (err: unknown) {
      if (err instanceof AbortedError) throw err;
      if (opts.signal.aborted) throw new AbortedError(opts.signal.reason);
      const info = opts.classify(err);
      if (info.kind === "abort") throw new AbortedError(opts.signal.reason);
      if (!info.retryable) throw new NonRetryableError(info);
      if (attempt >= o.maxRetries) throw new RetriesExhaustedError(info, attempt + 1);
      const delay = backoffDelay(attempt, info, o);
      if (opts.deadlineAt !== undefined) {
        const remaining = opts.deadlineAt - Date.now();
        if (delay >= remaining) throw new RetryBeyondDeadlineError(info, delay, remaining);
      }
      opts.logger?.warn(`${opts.label ?? "model call"} failed, retrying`, {
        kind: info.kind,
        status: info.status,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await sleep(delay, opts.signal);
    }
  }
}
