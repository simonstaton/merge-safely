import { randomUUID } from "node:crypto";
import { verifyMfa } from "./mfa.js";
import type { Device, Session, User } from "./types.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class MfaRequiredError extends Error {}

export async function createSession(user: User, device: Device, mfaCode?: string): Promise<Session> {
  if (!(await verifyMfa(user, mfaCode))) throw new MfaRequiredError("mfa required");
  return { id: randomUUID(), userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS };
}
