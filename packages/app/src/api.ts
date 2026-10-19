/**
 * Bearer-protected JSON endpoints:
 *   GET  /installations/:id/prs/:n?repo=owner/name   verdict, digest and history via gate.explain
 *   POST /installations/:id/verdict                  human verdict (design 14 Q3: a human pass replaces a machine
 *                                                    block, with provenance: signedBy + reason, SHA-bound)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AppDb } from "./db.js";
import { FORM_BODY_LIMIT, hasBearer, readBody, sendJson } from "./http.js";
import { type AppLogger, errText, type SecretSet } from "./logger.js";
import type { Prepared } from "./run-job.js";

export interface ApiDeps {
  db: AppDb;
  setupToken: string;
  logger: AppLogger;
  secrets: SecretSet;
  prepare(installationId: number, repo: string, number: number, headSha?: string): Promise<Prepared>;
}

const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must be owner/name");

export const humanVerdictSchema = z
  .object({
    repo: repoSchema,
    number: z.number().int().positive(),
    headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "headSha must be a full commit sha"),
    decision: z.enum(["pass", "block"]),
    reason: z.string().trim().min(3, "reason is required").max(2000),
    signedBy: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, "signedBy must be a GitHub login"),
  })
  .strict();

export const PRS_ROUTE = /^\/installations\/(\d{1,15})\/prs\/(\d{1,10})$/;
export const VERDICT_ROUTE = /^\/installations\/(\d{1,15})\/verdict$/;

function knownInstallation(db: AppDb, id: number): boolean {
  const row = db.getInstallation(id);
  return row !== undefined && row.deleted_at === null;
}

export async function apiHandler(deps: ApiDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const prs = PRS_ROUTE.exec(url.pathname);
  const verdict = VERDICT_ROUTE.exec(url.pathname);
  if (!prs && !verdict) return false;
  if (!hasBearer(req, deps.setupToken)) {
    req.resume();
    sendJson(res, 401, { error: "bearer token required" }, { "www-authenticate": "Bearer" });
    return true;
  }
  const installationId = Number((prs ?? verdict)?.[1]);
  if (!knownInstallation(deps.db, installationId)) {
    req.resume();
    sendJson(res, 404, { error: "unknown installation" });
    return true;
  }
  try {
    if (prs) {
      if (req.method !== "GET") return methodNotAllowed(res);
      const repo = repoSchema.safeParse(url.searchParams.get("repo") ?? "");
      if (!repo.success) {
        sendJson(res, 400, { error: "query parameter repo=owner/name is required" });
        return true;
      }
      const prep = await deps.prepare(installationId, repo.data, Number(prs[2]));
      if (prep.kind === "invalid-policy") {
        sendJson(res, 409, {
          error: "invalid .merge-safely.yml on the base branch",
          baseRef: prep.baseRef,
          errors: prep.errors,
        });
        return true;
      }
      const out = await prep.gate.explain(prep.ref);
      sendJson(res, 200, { headSha: prep.headSha, baseRef: prep.baseRef, policyHash: prep.policyHash, ...out });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res);
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, FORM_BODY_LIMIT)).toString("utf8"));
    } catch (_err: unknown) {
      sendJson(res, 400, { error: "body must be JSON" });
      return true;
    }
    const input = humanVerdictSchema.safeParse(body);
    if (!input.success) {
      sendJson(res, 400, {
        error: "invalid human verdict",
        issues: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return true;
    }
    const v = input.data;
    const prep = await deps.prepare(installationId, v.repo, v.number, v.headSha);
    if (prep.kind === "invalid-policy") {
      sendJson(res, 409, {
        error: "invalid .merge-safely.yml on the base branch",
        baseRef: prep.baseRef,
        errors: prep.errors,
      });
      return true;
    }
    const recorded = await prep.gate.recordHumanVerdict({
      ref: prep.ref,
      headSha: v.headSha,
      decision: v.decision,
      signedBy: { kind: "human", login: v.signedBy },
      reason: v.reason,
    });
    deps.logger.info("human verdict recorded", {
      installationId,
      repo: v.repo,
      number: v.number,
      headSha: v.headSha,
      decision: v.decision,
      signedBy: v.signedBy,
    });
    sendJson(res, 201, { verdict: recorded });
    return true;
  } catch (err: unknown) {
    const message = deps.secrets.scrub(errText(err));
    deps.logger.error("admin API request failed", { path: url.pathname, error: message });
    const status =
      typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404
        ? 404
        : 502;
    sendJson(res, status, { error: status === 404 ? "not found on GitHub" : message.slice(0, 500) });
    return true;
  }
}

function methodNotAllowed(res: ServerResponse): true {
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
