// @merge-safely/escalation-slack — Slack webhook Escalation and Reporter
import { randomUUID } from "node:crypto";
import type {
  Escalation,
  EscalationHandle,
  HumanDigest,
  Logger,
  ReportEvent,
  Reporter,
  Verdict,
} from "@merge-safely/core";
import { escalationMessage, type ResolveHint, reportMessage } from "./format.js";
import { assertWebhookUrl, type FetchLike, postToWebhook, scrubWebhook } from "./webhook.js";

export * from "./format.js";
export * from "./webhook.js";

export interface SlackEscalationOptions {
  /** Incoming webhook URL. A secret: never logged, never in errors. */
  webhookUrl: string;
  fetch?: FetchLike;
  /** Shown in the message context (incoming webhooks are bound to one channel; this does not reroute). */
  channelHint?: string;
  /** Per-attempt timeout, default 10 s. */
  timeoutMs?: number;
  /**
   * Replaces the resolve instruction. Default:
   * `merge-safely verdict --repo owner/name --pr <n> --sha <sha> --decision pass|block --reason "…"`.
   */
  resolveHint?: ResolveHint;
}

/**
 * Escalation via a Slack incoming webhook. Webhooks return no message id or permalink, so the handle is a
 * locally generated UUID with no `url`, and `resolve` is not supported: humans resolve by posting a
 * SHA-bound human verdict (`merge-safely verdict ...`), which the verdict store picks up.
 */
export function slackEscalation(opts: SlackEscalationOptions): Escalation {
  assertWebhookUrl(opts.webhookUrl);
  return {
    async request(v: Verdict, digest: HumanDigest): Promise<EscalationHandle> {
      const handle: EscalationHandle = { id: randomUUID(), createdAt: new Date().toISOString() };
      await postToWebhook(
        opts.webhookUrl,
        escalationMessage(v, digest, {
          ...(opts.channelHint !== undefined ? { channelHint: opts.channelHint } : {}),
          ...(opts.resolveHint !== undefined ? { resolveHint: opts.resolveHint } : {}),
        }),
        {
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        },
      );
      return handle;
    },
    // resolve is deliberately absent: incoming webhooks are write-only.
  };
}

export type ReportEventType = ReportEvent["type"];

/**
 * Default events. `escalated` is left out because `slackEscalation` already posts the full escalation message;
 * add it when the reporter and the escalation go to different webhooks.
 */
export const DEFAULT_REPORT_EVENTS: readonly ReportEventType[] = ["verdict", "budget-blocked", "error"];

export interface SlackReporterOptions {
  webhookUrl: string;
  fetch?: FetchLike;
  /** Event types to post. Default: verdict, budget-blocked, error. `pending` is never posted. */
  events?: ReportEventType[];
  timeoutMs?: number;
  /** Where failures are logged. Default: console.warn. Messages never include the webhook URL. */
  logger?: Pick<Logger, "warn">;
}

const consoleLogger: Pick<Logger, "warn"> = {
  warn: (msg, meta) => console.warn(msg, meta ?? ""),
};

/** Reporter that posts short Slack messages. `report` never throws: failures are logged and swallowed. */
export function slackReporter(opts: SlackReporterOptions): Reporter {
  assertWebhookUrl(opts.webhookUrl);
  const events = new Set<ReportEventType>((opts.events ?? DEFAULT_REPORT_EVENTS).filter((e) => e !== "pending"));
  const logger = opts.logger ?? consoleLogger;
  return {
    async report(event: ReportEvent): Promise<void> {
      if (event.type === "pending" || !events.has(event.type)) return;
      try {
        await postToWebhook(opts.webhookUrl, reportMessage(event), {
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
      } catch (err: unknown) {
        const msg = scrubWebhook(err instanceof Error ? err.message : String(err), opts.webhookUrl);
        try {
          logger.warn(`slack reporter: could not post ${event.type} event: ${msg}`, {
            repo: `${event.change.repo.owner}/${event.change.repo.name}`,
            number: event.change.number,
          });
        } catch (_logErr: unknown) {
          // a broken logger must not break the pipeline either
        }
      }
    },
  };
}
