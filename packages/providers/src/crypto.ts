/**
 * Envelope encryption for connection secrets.
 *
 * Each blob gets its own random 32-byte data key. The secret JSON is sealed with the data key
 * (AES-256-GCM), and the data key itself is sealed with the master key (AES-256-GCM). Both seals
 * bind the connection id as additional authenticated data, so a blob copied onto another record
 * fails to open.
 *
 * Blob format: `v1:` followed by base64 of this JSON (all binary fields base64):
 *
 *   {
 *     "v": 1,
 *     "alg": "A256GCM",
 *     "kdf"?: { "name": "scrypt", "salt": "...", "N": 32768, "r": 8, "p": 1 },  // passphrase master keys only
 *     "wk": { "iv": "...", "ct": "...", "tag": "..." },   // data key wrapped by the master key, aad "merge-safely:dk:v1:" + aad
 *     "iv": "...", "ct": "...", "tag": "..."              // secret JSON sealed by the data key, aad "merge-safely:secret:v1:" + aad
 *   }
 *
 * Master keys: a 32-byte Buffer, a 64-char hex string, or base64 that decodes to exactly 32 bytes are used
 * as-is. Any other string is treated as a passphrase and stretched with scrypt using a random salt that is
 * stored in the blob (`kdf`), so the blob stays self-describing.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { ConnectionSecret } from "@merge-safely/core";
import { connectionSecretSchema } from "./schema.js";

const PREFIX = "v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const MIN_PASSPHRASE = 12;

interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

interface Envelope extends Sealed {
  v: 1;
  alg: "A256GCM";
  kdf?: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  wk: Sealed;
}

/** Thrown for any decryption failure. Messages never include key or plaintext material. */
export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/** A fresh random master key as 64 hex characters. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

type RawKey = { kind: "raw"; key: Buffer } | { kind: "passphrase"; passphrase: string };

function classifyMasterKey(masterKey: string | Buffer): RawKey {
  if (Buffer.isBuffer(masterKey)) {
    if (masterKey.length !== KEY_BYTES) throw new Error(`master key buffer must be ${KEY_BYTES} bytes`);
    return { kind: "raw", key: Buffer.from(masterKey) };
  }
  const s = masterKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { kind: "raw", key: Buffer.from(s, "hex") };
  if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === KEY_BYTES) return { kind: "raw", key: b };
  }
  if (s.length < MIN_PASSPHRASE) {
    throw new Error(
      `master key must be 32 bytes as hex or base64, or a passphrase of at least ${MIN_PASSPHRASE} characters`,
    );
  }
  return { kind: "passphrase", passphrase: s };
}

function scryptKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, { ...params, maxmem: 128 * params.N * params.r * 2 });
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
}

const dkAad = (aad: string) => `merge-safely:dk:v1:${aad}`;
const secretAad = (aad: string) => `merge-safely:secret:v1:${aad}`;

/** Encrypt a connection secret. `aad` must be the connection id. */
export function encryptSecret(secret: ConnectionSecret, masterKey: string | Buffer, aad: string): string {
  const parsed = connectionSecretSchema.parse(secret);
  const mk = classifyMasterKey(masterKey);
  let kek: Buffer;
  let kdf: Envelope["kdf"];
  if (mk.kind === "raw") {
    kek = mk.key;
  } else {
    const salt = randomBytes(16);
    kek = scryptKey(mk.passphrase, salt, SCRYPT);
    kdf = { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT };
  }
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const wk = seal(kek, dataKey, dkAad(aad));
    const body = seal(dataKey, Buffer.from(JSON.stringify(parsed), "utf8"), secretAad(aad));
    const env: Envelope = { v: 1, alg: "A256GCM", ...(kdf ? { kdf } : {}), wk, ...body };
    return PREFIX + Buffer.from(JSON.stringify(env), "utf8").toString("base64");
  } finally {
    dataKey.fill(0);
  }
}

function isSealed(x: unknown): x is Sealed {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.iv === "string" && typeof o.ct === "string" && typeof o.tag === "string";
}

function parseEnvelope(blob: string): Envelope {
  if (!blob.startsWith(PREFIX)) throw new SecretDecryptError("unsupported secret blob format (expected v1:)");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(blob.slice(PREFIX.length), "base64").toString("utf8"));
  } catch (_err: unknown) {
    throw new SecretDecryptError("secret blob is not valid base64 JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new SecretDecryptError("secret blob is malformed");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.alg !== "A256GCM" || !isSealed(o) || !isSealed(o.wk)) {
    throw new SecretDecryptError("secret blob is malformed or uses an unsupported version");
  }
  if (o.kdf !== undefined) {
    const k = o.kdf as Record<string, unknown>;
    if (
      typeof k !== "object" ||
      k === null ||
      k.name !== "scrypt" ||
      typeof k.salt !== "string" ||
      typeof k.N !== "number" ||
      typeof k.r !== "number" ||
      typeof k.p !== "number"
    ) {
      throw new SecretDecryptError("secret blob has an unsupported key derivation");
    }
  }
  return o as unknown as Envelope;
}

/** Decrypt a blob produced by `encryptSecret`. Throws `SecretDecryptError` on a wrong key, wrong aad or tampering. */
export function decryptSecret(blob: string, masterKey: string | Buffer, aad: string): ConnectionSecret {
  const env = parseEnvelope(blob);
  const mk = classifyMasterKey(masterKey);
  let kek: Buffer;
  if (env.kdf) {
    if (mk.kind !== "passphrase") {
      throw new SecretDecryptError("secret was encrypted with a passphrase but a raw master key was given");
    }
    const { N, r, p } = env.kdf;
    if (N > 2 ** 20 || r > 32 || p > 16) throw new SecretDecryptError("secret blob key derivation cost is too high");
    kek = scryptKey(mk.passphrase, Buffer.from(env.kdf.salt, "base64"), { N, r, p });
  } else {
    if (mk.kind !== "raw") {
      throw new SecretDecryptError("secret was encrypted with a raw master key but a passphrase was given");
    }
    kek = mk.key;
  }
  let dataKey: Buffer;
  try {
    dataKey = open(kek, env.wk, dkAad(aad));
  } catch (_err: unknown) {
    throw new SecretDecryptError(
      "could not decrypt secret: wrong master key, wrong connection id, or the blob was modified",
    );
  }
  let plaintext: Buffer;
  try {
    plaintext = open(dataKey, env, secretAad(aad));
  } catch (_err: unknown) {
    throw new SecretDecryptError("could not decrypt secret: the blob was modified or belongs to another connection");
  } finally {
    dataKey.fill(0);
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString("utf8"));
  } catch (_err: unknown) {
    throw new SecretDecryptError("decrypted secret is not valid JSON");
  } finally {
    plaintext.fill(0);
  }
  const result = connectionSecretSchema.safeParse(json);
  if (!result.success) throw new SecretDecryptError("decrypted secret does not match a known connection kind");
  return result.data;
}
