import { randomBytes } from "node:crypto";
import type { ConnectionSecret } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateMasterKey, SecretDecryptError } from "./crypto.js";

const secret: ConnectionSecret = { kind: "api-key", apiKey: "sk-ant-test-1234567890abcdef" };

function tamper(blob: string, mutate: (env: Record<string, unknown>) => void): string {
  const env = JSON.parse(Buffer.from(blob.slice(3), "base64").toString("utf8")) as Record<string, unknown>;
  mutate(env);
  return `v1:${Buffer.from(JSON.stringify(env)).toString("base64")}`;
}

function flip(b64: string): string {
  const b = Buffer.from(b64, "base64");
  b[0] = (b[0] ?? 0) ^ 0xff;
  return b.toString("base64");
}

describe("envelope encryption", () => {
  it("generates a 32 byte hex master key", () => {
    const k = generateMasterKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(generateMasterKey()).not.toBe(k);
  });

  it("round trips with a hex key and never contains the plaintext", () => {
    const mk = generateMasterKey();
    const blob = encryptSecret(secret, mk, "anthropic-main");
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("sk-ant");
    expect(Buffer.from(blob.slice(3), "base64").toString()).not.toContain("sk-ant");
    expect(decryptSecret(blob, mk, "anthropic-main")).toEqual(secret);
  });

  it("round trips with base64 and Buffer keys", () => {
    const raw = randomBytes(32);
    const blob = encryptSecret(secret, `base64:${raw.toString("base64")}`, "c1");
    expect(decryptSecret(blob, raw, "c1")).toEqual(secret);
    expect(decryptSecret(blob, raw.toString("hex"), "c1")).toEqual(secret);
  });

  it("round trips with a passphrase (scrypt, salt stored in the blob)", () => {
    const s: ConnectionSecret = {
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-key-123456",
    };
    const blob = encryptSecret(s, "correct horse battery staple", "router");
    const env = JSON.parse(Buffer.from(blob.slice(3), "base64").toString()) as { kdf?: { name: string } };
    expect(env.kdf?.name).toBe("scrypt");
    expect(decryptSecret(blob, "correct horse battery staple", "router")).toEqual(s);
    expect(() => decryptSecret(blob, "wrong horse battery staple", "router")).toThrow(SecretDecryptError);
  });

  it("uses a fresh data key and iv per blob", () => {
    const mk = generateMasterKey();
    expect(encryptSecret(secret, mk, "a")).not.toBe(encryptSecret(secret, mk, "a"));
  });

  it("fails with the wrong key", () => {
    const blob = encryptSecret(secret, generateMasterKey(), "a");
    expect(() => decryptSecret(blob, generateMasterKey(), "a")).toThrow(/wrong master key/);
  });

  it("fails when the blob is moved to another connection id", () => {
    const mk = generateMasterKey();
    const blob = encryptSecret(secret, mk, "a");
    expect(() => decryptSecret(blob, mk, "b")).toThrow(SecretDecryptError);
  });

  it("fails on tampering with the ciphertext, tag, iv or wrapped key", () => {
    const mk = generateMasterKey();
    const blob = encryptSecret(secret, mk, "a");
    for (const field of ["ct", "tag", "iv"]) {
      const t = tamper(blob, (e) => {
        e[field] = flip(e[field] as string);
      });
      expect(() => decryptSecret(t, mk, "a")).toThrow(SecretDecryptError);
    }
    const wk = tamper(blob, (e) => {
      const w = e.wk as Record<string, string>;
      w.ct = flip(w.ct ?? "");
    });
    expect(() => decryptSecret(wk, mk, "a")).toThrow(SecretDecryptError);
  });

  it("rejects malformed blobs and mismatched key types without leaking key material", () => {
    const mk = generateMasterKey();
    expect(() => decryptSecret("v2:abc", mk, "a")).toThrow(/unsupported/);
    expect(() => decryptSecret("v1:!!!", mk, "a")).toThrow(SecretDecryptError);
    const blob = encryptSecret(secret, mk, "a");
    try {
      decryptSecret(blob, "zebra-umbrella-phrase-77", "a");
      expect.unreachable();
    } catch (err: unknown) {
      expect(String(err)).not.toContain(mk);
      expect(String(err)).not.toContain("zebra-umbrella");
    }
  });

  it("rejects weak master keys and invalid secrets", () => {
    expect(() => encryptSecret(secret, "short", "a")).toThrow(/at least 12/);
    expect(() => encryptSecret(secret, Buffer.alloc(16), "a")).toThrow(/32 bytes/);
    expect(() => encryptSecret({ kind: "api-key", apiKey: "" }, generateMasterKey(), "a")).toThrow();
  });

  it("treats unprefixed base64-looking strings as passphrases, not raw keys", () => {
    const b64 = randomBytes(32).toString("base64");
    const blob = encryptSecret(secret, b64, "a");
    const env = JSON.parse(Buffer.from(blob.slice(3), "base64").toString()) as { kdf?: unknown };
    expect(env.kdf).toBeDefined();
    expect(() => decryptSecret(blob, `base64:${b64}`, "a")).toThrow(SecretDecryptError);
    expect(decryptSecret(blob, b64, "a")).toEqual(secret);
    expect(() => encryptSecret(secret, "base64:abcd", "a")).toThrow(/exactly 32 bytes/);
  });

  it("rejects truncated tags and wrong-length ivs on both layers", () => {
    const mk = generateMasterKey();
    const blob = encryptSecret(secret, mk, "a");
    const cut = (b64: string, n: number) => Buffer.from(b64, "base64").subarray(0, n).toString("base64");
    for (const n of [4, 8, 12, 15]) {
      const body = tamper(blob, (e) => {
        e.tag = cut(e.tag as string, n);
      });
      expect(() => decryptSecret(body, mk, "a")).toThrow(/invalid iv or tag length/);
      const wk = tamper(blob, (e) => {
        const w = e.wk as Record<string, string>;
        w.tag = cut(w.tag ?? "", n);
      });
      expect(() => decryptSecret(wk, mk, "a")).toThrow(/invalid iv or tag length/);
    }
    const iv = tamper(blob, (e) => {
      e.iv = Buffer.alloc(16).toString("base64");
    });
    expect(() => decryptSecret(iv, mk, "a")).toThrow(/invalid iv or tag length/);
  });

  it("rejects out-of-range scrypt parameters before deriving", () => {
    const blob = encryptSecret(secret, "correct horse battery staple", "a");
    const bad = [
      { N: 3 },
      { N: -1 },
      { N: 2 ** 13 },
      { N: 2 ** 21 },
      { N: 2 ** 15 + 1 },
      { r: 32 },
      { r: 1 },
      { p: 0 },
      { p: 5 },
      { p: 1.5 },
    ];
    for (const patch of bad) {
      const t = tamper(blob, (e) => {
        Object.assign(e.kdf as Record<string, unknown>, patch);
      });
      expect(() => decryptSecret(t, "correct horse battery staple", "a")).toThrow(SecretDecryptError);
      expect(() => decryptSecret(t, "correct horse battery staple", "a")).toThrow(/out-of-range/);
    }
  });

  it("wraps every failure in SecretDecryptError", () => {
    const blob = encryptSecret(secret, generateMasterKey(), "a");
    expect(() => decryptSecret(blob, "short", "a")).toThrow(SecretDecryptError);
    expect(() => decryptSecret(blob, Buffer.alloc(3), "a")).toThrow(SecretDecryptError);
  });
});
