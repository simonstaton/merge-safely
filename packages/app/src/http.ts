/** Small node:http helpers: capped body reads, responses, bearer auth. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;
export const FORM_BODY_LIMIT = 256 * 1024;

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new BodyTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};

export function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType, ...extra });
  res.end(body);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  send(res, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8", extra);
}

/** Timing-safe comparison of arbitrary-length strings (both sides hashed to a fixed length first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** True when the request carries `Authorization: Bearer <token>`. Cookies and query tokens are never accepted. */
export function hasBearer(req: IncomingMessage, token: string): boolean {
  const h = header(req, "authorization");
  if (!h || !token) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1] !== undefined && safeEqual(m[1], token);
}

export function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body.toString("utf8"))) out[k] = v;
  return out;
}
