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
 * Master keys: a 32-byte Buffer, exactly 64 hex characters, or `base64:` followed by base64 that decodes to
 * exactly 32 bytes are used as-is. Every other string is a passphrase (at least 12 characters) stretched with
 * scrypt using a random salt stored in the blob (`kdf`), so the blob stays self-describing.
 *
 * Decryption checks the envelope strictly before touching any key: 12-byte IVs, 16-byte GCM tags (decipher is
 * created with `authTagLength: 16`, so truncated tags are rejected), and scrypt parameters limited to
 * N a power of two in [2^14, 2^20], r = 8, p in [1, 4]. Every failure is a `SecretDecryptError`.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { ConnectionSecret } from "@merge-safely/core";
import { connectionSecretSchema } from "./schema.js";

const PREFIX = "v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_LIMITS = { minN: 2 ** 14, maxN: 2 ** 20, r: 8, minP: 1, maxP: 4 } as const;
const BASE64_PREFIX = "base64:";
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
  if (s.startsWith(BASE64_PREFIX)) {
    const body = s.slice(BASE64_PREFIX.length);
    const b = /^[A-Za-z0-9+/_-]+={0,2}$/.test(body)
      ? Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      : Buffer.alloc(0);
    if (b.length !== KEY_BYTES) throw new Error(`a base64: master key must decode to exactly ${KEY_BYTES} bytes`);
    return { kind: "raw", key: b };
  }
  if (s.length < MIN_PASSPHRASE) {
    throw new Error(
      `master key must be 64 hex characters, base64:<32 bytes>, or a passphrase of at least ${MIN_PASSPHRASE} characters`,
    );
  }
  return { kind: "passphrase", passphrase: s };
}

function scryptKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  // scrypt needs about 128 * N * r bytes (plus 128 * r * p); leave 1 MiB headroom and no more.
  const maxmem = 128 * params.N * params.r + 128 * params.r * params.p + 1024 * 1024;
  return scryptSync(passphrase, salt, KEY_BYTES, { ...params, maxmem });
}

function checkScryptParams(k: { N: number; r: number; p: number }): void {
  const { minN, maxN, r, minP, maxP } = SCRYPT_LIMITS;
  const powerOfTwo = Number.isInteger(k.N) && k.N > 0 && (k.N & (k.N - 1)) === 0;
  if (!powerOfTwo || k.N < minN || k.N > maxN || k.r !== r || !Number.isInteger(k.p) || k.p < minP || k.p > maxP) {
    throw new SecretDecryptError("secret blob has out-of-range key derivation parameters");
  }
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** Decode and length-check a sealed box before any crypto runs. */
function decodeSealed(sealed: Sealed, what: string): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = Buffer.from(sealed.iv, "base64");
  const tag = Buffer.from(sealed.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretDecryptError(`secret blob ${what} has an invalid iv or tag length`);
  }
  return { iv, tag, ct: Buffer.from(sealed.ct, "base64") };
}

function open(key: Buffer, box: { iv: Buffer; ct: Buffer; tag: Buffer }, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, box.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(box.tag);
  return Buffer.concat([decipher.update(box.ct), decipher.final()]);
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
  try {
    return decryptInner(blob, masterKey, aad);
  } catch (err: unknown) {
    if (err instanceof SecretDecryptError) throw err;
    // Anything else (bad master key format, a crypto RangeError) is reported without its original text.
    throw new SecretDecryptError(
      err instanceof Error && /master key/.test(err.message) ? err.message : "could not decrypt secret",
    );
  }
}

function decryptInner(blob: string, masterKey: string | Buffer, aad: string): ConnectionSecret {
  const env = parseEnvelope(blob);
  const wkBox = decodeSealed(env.wk, "key wrap");
  const bodyBox = decodeSealed(env, "body");
  if (env.kdf) checkScryptParams(env.kdf);
  const mk = classifyMasterKey(masterKey);
  let kek: Buffer;
  if (env.kdf) {
    if (mk.kind !== "passphrase") {
      throw new SecretDecryptError("secret was encrypted with a passphrase but a raw master key was given");
    }
    const salt = Buffer.from(env.kdf.salt, "base64");
    if (salt.length < 16) throw new SecretDecryptError("secret blob has an invalid key derivation salt");
    try {
      kek = scryptKey(mk.passphrase, salt, env.kdf);
    } catch (_err: unknown) {
      throw new SecretDecryptError("could not derive the key from the passphrase");
    }
  } else {
    if (mk.kind !== "raw") {
      throw new SecretDecryptError("secret was encrypted with a raw master key but a passphrase was given");
    }
    kek = mk.key;
  }
  let dataKey: Buffer;
  try {
    dataKey = open(kek, wkBox, dkAad(aad));
  } catch (_err: unknown) {
    throw new SecretDecryptError(
      "could not decrypt secret: wrong master key, wrong connection id, or the blob was modified",
    );
  }
  let plaintext: Buffer;
  try {
    if (dataKey.length !== KEY_BYTES) throw new Error("bad data key");
    plaintext = open(dataKey, bodyBox, secretAad(aad));
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
