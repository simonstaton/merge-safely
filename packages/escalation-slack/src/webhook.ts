/**
 * Minimal Slack incoming-webhook client. The webhook URL is a bearer secret: it is never logged and is
 * scrubbed from every error message this module produces.
 */

export type FetchLike = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Thrown when a webhook post fails. The message never contains the webhook URL. */
export class SlackWebhookError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SlackWebhookError";
    this.status = status;
  }
}

const SLACK_HOOK_PATTERN = /https?:\/\/hooks\.slack(?:-gov)?\.com\/[^\s"'<>]*/gi;

/** Remove the webhook URL (and anything shaped like a Slack hook URL) from text. */
export function scrubWebhook(text: string, webhookUrl: string): string {
  let out = webhookUrl ? text.split(webhookUrl).join("[webhook]") : text;
  out = out.replace(SLACK_HOOK_PATTERN, "[webhook]");
  // Also the path alone (T…/B…/secret) in case a library printed a parsed URL.
  try {
    const path = new URL(webhookUrl).pathname;
    if (path.length > 10) out = out.split(path).join("[webhook]");
  } catch (_err: unknown) {
    // invalid URLs are rejected at construction; nothing to scrub
  }
  return out;
}

/** Validate a webhook URL without echoing it. */
export function assertWebhookUrl(webhookUrl: string): void {
  let u: URL;
  try {
    u = new URL(webhookUrl);
  } catch (_err: unknown) {
    throw new SlackWebhookError("Slack webhook URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new SlackWebhookError("Slack webhook URL must use https");
}

export const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

export interface PostOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Injectable delay, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After in ms (seconds or an HTTP date), capped at 10 s; 1 s when absent or unparsable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(header.trim());
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms) || ms < 0) ms = DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

type Attempt = { ok: true } | { ok: false; retryable: boolean; message: string; status?: number; waitMs?: number };

async function once(webhookUrl: string, body: string, f: FetchLike, timeoutMs: number): Promise<Attempt> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
      signal: ctl.signal,
    });
    if (res.ok) return { ok: true };
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200).trim();
    } catch (_err: unknown) {
      // body unreadable; status is enough
    }
    return {
      ok: false,
      retryable: res.status >= 500 || res.status === 429,
      status: res.status,
      ...(res.status === 429 ? { waitMs: retryAfterMs(res.headers.get("retry-after")) } : {}),
      message: `HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
    };
  } catch (err: unknown) {
    if (ctl.signal.aborted) return { ok: false, retryable: false, message: `timed out after ${timeoutMs} ms` };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, retryable: true, message: `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a JSON payload to a Slack incoming webhook. Retries once on a 5xx, a network error, or a 429 (after
 * Retry-After, capped at 10 s); 4xx and timeouts are not retried. Each attempt times out after `timeoutMs`
 * (default 10 s). Throws `SlackWebhookError` on failure.
 *
 * A network-error retry can double-post if the first request reached Slack; for notifications that is the
 * better failure than silence.
 */
export async function postToWebhook(webhookUrl: string, payload: unknown, opts: PostOptions = {}): Promise<void> {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(payload);
  let last = await once(webhookUrl, body, f, timeoutMs);
  if (!last.ok && last.retryable) {
    if (last.waitMs) await (opts.sleep ?? defaultSleep)(last.waitMs);
    last = await once(webhookUrl, body, f, timeoutMs);
  }
  if (last.ok) return;
  throw new SlackWebhookError(scrubWebhook(`Slack webhook post failed: ${last.message}`, webhookUrl), last.status);
}
