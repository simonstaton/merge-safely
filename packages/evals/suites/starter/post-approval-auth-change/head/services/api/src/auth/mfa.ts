import type { Device, User } from "./types.js";

export async function verifyMfa(user: User, code: string | undefined): Promise<boolean> {
  if (!user.mfaEnrolled) return true;
  if (!code) return false;
  return user.totp.verify(code);
}

export function isTrustedDevice(device: Device): boolean {
  return device.trustedUntil !== undefined && device.trustedUntil > Date.now();
}
