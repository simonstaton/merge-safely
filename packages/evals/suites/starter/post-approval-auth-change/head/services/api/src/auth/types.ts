export interface User {
  id: string;
  mfaEnrolled: boolean;
  totp: { verify(code: string): Promise<boolean> };
}

export interface Device {
  id: string;
  /** Set by the user ticking "trust this device" after a successful MFA challenge. Client-reported. */
  trustedUntil?: number;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}
