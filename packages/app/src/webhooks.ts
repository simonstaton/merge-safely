/**
 * POST /webhooks/github. Verify, dedupe, map, enqueue, answer 202 fast; the worker does the rest.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { changeRefFromEvent, verifyWebhookSignature } from "@merge-safely/github";
import type { AppDb } from "./db.js";
import { BodyTooLargeError, header, readBody, sendJson, WEBHOOK_BODY_LIMIT } from "./http.js";
import { type AppLogger, errText } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export interface WebhookDeps {
  db: AppDb;
  webhookSecret: string;
  logger: AppLogger;
  metrics: MetricsRegistry;
  /** Wake the worker after an enqueue. */
  wake?: () => void;
  /** Admission-time budget evaluation for the installation (fire and forget). */
  onIntake?: (installationId: number) => Promise<unknown>;
  triggerLabels?: string[];
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

function installationOf(payload: Record<string, unknown>): { id: number; account?: string } | undefined {
  const inst = payload.installation;
  if (!isObj(inst) || typeof inst.id !== "number" || !Number.isInteger(inst.id) || inst.id <= 0) return undefined;
  const account = isObj(inst.account) && typeof inst.account.login === "string" ? inst.account.login : undefined;
  return account ? { id: inst.id, account } : { id: inst.id };
}

function repoOwner(payload: Record<string, unknown>): string | undefined {
  const r = payload.repository;
  return isObj(r) && isObj(r.owner) && typeof r.owner.login === "string" ? r.owner.login : undefined;
}

/** The pure part: everything after the signature check and body read. */
export function handleEvent(
  deps: WebhookDeps,
  event: string,
  payload: unknown,
): WebhookResult & { enqueued?: number; installationId?: number } {
  if (!isObj(payload)) return { status: 400, body: { error: "payload is not a JSON object" } };
  const action = typeof payload.action === "string" ? payload.action : "";
  const inst = installationOf(payload);

  if (event === "ping") return { status: 200, body: { ok: true, pong: true } };

  if (event === "installation") {
    if (!inst) return { status: 400, body: { error: "installation event without installation id" } };
    if (action === "deleted") {
      deps.db.deleteInstallation(inst.id);
      deps.logger.info("installation removed; its connections and settings were purged", { installationId: inst.id });
      return { status: 200, body: { ok: true, installation: "deleted" } };
    }
    deps.db.upsertInstallation(inst.id, inst.account ?? "unknown");
    deps.logger.info("installation event", { installationId: inst.id, action });
    return { status: 200, body: { ok: true, installation: action || "updated" } };
  }

  if (event === "installation_repositories") {
    if (!inst) return { status: 400, body: { error: "installation_repositories event without installation id" } };
    deps.db.upsertInstallation(inst.id, inst.account ?? "unknown");
    return { status: 200, body: { ok: true } };
  }

  const hit = changeRefFromEvent(event, payload, deps.triggerLabels ? { triggerLabels: deps.triggerLabels } : {});
  if (!hit) return { status: 202, body: { ignored: true, reason: "not a reviewable event" } };
  // Apps never get pull_request_target; Actions-style deliveries would double-review with base privileges.
  if (hit.targetEvent) return { status: 202, body: { ignored: true, reason: "pull_request_target is not handled" } };
  if (hit.draft) return { status: 202, body: { ignored: true, reason: "draft pull request" } };
  if (!inst) return { status: 400, body: { error: "event without installation id" } };

  if (!deps.db.getInstallation(inst.id) || deps.db.getInstallation(inst.id)?.deleted_at) {
    deps.db.upsertInstallation(inst.id, inst.account ?? repoOwner(payload) ?? "unknown");
  }
  const repo = `${hit.ref.repo.owner}/${hit.ref.repo.name}`;
  const r = deps.db.enqueue({
    installationId: inst.id,
    repo,
    number: hit.ref.number,
    headSha: hit.headSha ?? "",
    event: `${event}.${hit.action}`,
  });
  deps.logger.info("webhook enqueued", {
    installationId: inst.id,
    repo,
    number: hit.ref.number,
    headSha: hit.headSha,
    jobId: r.id,
    coalesced: r.coalesced,
    superseded: [...r.supersededQueued, ...r.supersededRunning],
  });
  return {
    status: 202,
    body: { queued: r.id, coalesced: r.coalesced, superseded: [...r.supersededQueued, ...r.supersededRunning] },
    enqueued: r.id,
    installationId: inst.id,
  };
}

export async function webhookHandler(deps: WebhookDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const event = header(req, "x-github-event") ?? "";
  const count = (outcome: string) =>
    deps.metrics.inc("merge_safely_webhooks_total", "Webhook deliveries, by event and outcome", {
      event: event.replace(/[^a-z_]/g, "").slice(0, 40) || "unknown",
      outcome,
    });
  let body: Buffer;
  try {
    body = await readBody(req, WEBHOOK_BODY_LIMIT);
  } catch (err: unknown) {
    count(err instanceof BodyTooLargeError ? "too-large" : "read-error");
    sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { error: errText(err) });
    return;
  }
  if (!verifyWebhookSignature(deps.webhookSecret, body, header(req, "x-hub-signature-256"))) {
    count("bad-signature");
    sendJson(res, 401, { error: "invalid signature" });
    return;
  }
  const delivery = header(req, "x-github-delivery");
  if (delivery && !deps.db.recordDelivery(delivery.slice(0, 128))) {
    count("duplicate");
    sendJson(res, 200, { duplicate: true });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (_err: unknown) {
    count("bad-json");
    sendJson(res, 400, { error: "body is not JSON" });
    return;
  }
  try {
    const r = handleEvent(deps, event, payload);
    count(r.enqueued !== undefined ? "enqueued" : r.status >= 400 ? "rejected" : "ignored");
    sendJson(res, r.status, r.body);
    if (r.enqueued !== undefined) deps.wake?.();
    if (r.installationId !== undefined && deps.onIntake) {
      deps
        .onIntake(r.installationId)
        .catch((err: unknown) => deps.logger.warn("admission budget check failed", { error: errText(err) }));
    }
  } catch (err: unknown) {
    // Let GitHub's redelivery retry it: forget the delivery id.
    if (delivery) deps.db.forgetDelivery(delivery.slice(0, 128));
    count("error");
    deps.logger.error("webhook processing failed", { event, error: errText(err) });
    sendJson(res, 500, { error: "internal error" });
  }
}
