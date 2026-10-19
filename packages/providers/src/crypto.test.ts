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
    const blob = encryptSecret(secret, raw.toString("base64"), "c1");
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
});
