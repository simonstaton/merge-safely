import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMasterKey, loadConnectionsFile } from "@merge-safely/providers";
import { describe, expect, it } from "vitest";
import { fakeProvider, harness, scriptedPrompter } from "./helpers.js";

const KEY = "sk-ant-api03-supersecretvalue-XYZ9";

function fileOf(home: string): { connections: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(home, "connections.json"), "utf8")) as { connections: Record<string, unknown>[] };
}

describe("connect", () => {
  it("validates, prints models and per-tier cost, and saves plaintext 0600 with a warning", async () => {
    const h = harness();
    const r = await h.run("connect", "anthropic", "--api-key", KEY);
    expect(r.code).toBe(0);
    expect(h.provider.validated).toHaveLength(1);
    expect(r.stdout).toContain("Connected anthropic-main");
    expect(r.stdout).toContain("claude-sonnet-5-5");
    expect(r.stdout).toMatch(/tier 1 .*claude-sonnet-5-5 .*claude-opus-5-5 .*\$\d+\.\d\d/);
    expect(r.stdout).toContain("tier 3");
    expect(r.stdout).toContain("Budget ceiling: $5.00 per seat, $25.00 per change");
    expect(r.stderr).toContain("plaintext");
    expect(r.stdout + r.stderr).not.toContain(KEY);
    const path = join(h.home, "connections.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const entry = fileOf(h.home).connections[0];
    expect(entry).toMatchObject({
      id: "anthropic-main",
      provider: "anthropic",
      kind: "api-key",
      secret: { apiKey: KEY },
    });
    expect(entry?.lastValidatedAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("stores only an env reference with --api-key-env", async () => {
    const h = harness({ env: { MY_KEY: KEY } });
    const r = await h.run(
      "connect",
      "anthropic",
      "--api-key-env",
      "MY_KEY",
      "--id",
      "claude",
      "--model",
      "claude-opus-5-5",
    );
    expect(r.code).toBe(0);
    const raw = readFileSync(join(h.home, "connections.json"), "utf8");
    expect(raw).not.toContain(KEY);
    expect(fileOf(h.home).connections[0]).toMatchObject({
      id: "claude",
      secretRef: { env: "MY_KEY" },
      defaultModel: "claude-opus-5-5",
    });
    const loaded = await loadConnectionsFile(join(h.home, "connections.json"), { MY_KEY: KEY });
    expect(loaded[0]?.secret).toEqual({ kind: "api-key", apiKey: KEY });
  });

  it("encrypts when MERGE_SAFELY_MASTER_KEY is set", async () => {
    const mk = generateMasterKey();
    const h = harness({ env: { MERGE_SAFELY_MASTER_KEY: mk } });
    expect((await h.run("connect", "anthropic", "--api-key", KEY)).code).toBe(0);
    const raw = readFileSync(join(h.home, "connections.json"), "utf8");
    expect(raw).not.toContain(KEY);
    const entry = fileOf(h.home).connections[0] as { secretRef: { encrypted: string } };
    expect(typeof entry.secretRef.encrypted).toBe("string");
    const loaded = await loadConnectionsFile(join(h.home, "connections.json"), { MERGE_SAFELY_MASTER_KEY: mk });
    expect(loaded[0]?.secret).toEqual({ kind: "api-key", apiKey: KEY });
  });

  it("does not save, and does not leak the key, when validation fails", async () => {
    const provider = fakeProvider({ validate: () => ({ ok: false, message: `401 invalid x-api-key ${KEY}` }) });
    const h = harness({ provider });
    const r = await h.run("connect", "anthropic", "--api-key", KEY);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [VALIDATION_FAILED]");
    expect(r.stderr).not.toContain(KEY);
    expect(() => statSync(join(h.home, "connections.json"))).toThrow();
  });

  it("--no-validate saves without calling the provider", async () => {
    const h = harness();
    const r = await h.run("connect", "anthropic", "--api-key", KEY, "--no-validate");
    expect(r.code).toBe(0);
    expect(h.provider.validated).toHaveLength(0);
    expect(fileOf(h.home).connections[0]?.lastValidatedAt).toBeUndefined();
  });

  it("prompts for the key with echo off when interactive", async () => {
    const prompter = scriptedPrompter([KEY]);
    const h = harness({ prompter });
    const r = await h.run("connect", "anthropic");
    expect(r.code).toBe(0);
    expect(prompter.asked[0]).toContain("input hidden");
    expect(fileOf(h.home).connections[0]).toMatchObject({ secret: { apiKey: KEY } });
  });

  it("errors clearly when non-interactive and no key is given; uses the conventional env var when set", async () => {
    let h = harness();
    let r = await h.run("connect", "openai");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [MISSING_API_KEY]");
    expect(r.stderr).toContain("OPENAI_API_KEY");
    h = harness({ env: { OPENAI_API_KEY: KEY }, provider: fakeProvider({ id: "openai", kinds: ["api-key"] }) });
    r = await h.run("connect", "openai");
    expect(r.code).toBe(0);
    expect(fileOf(h.home).connections[0]).toMatchObject({ id: "openai-main", secretRef: { env: "OPENAI_API_KEY" } });
  });

  it("handles gateways, local servers and compatible endpoints", async () => {
    const compat = fakeProvider({ id: "openai-compatible", kinds: ["openai-compatible"], models: [] });
    const h = harness({ env: { OPENROUTER_API_KEY: KEY }, extraProviders: [compat] });
    let r = await h.run("connect", "openrouter", "--api-key-env", "OPENROUTER_API_KEY");
    expect(r.code).toBe(0);
    expect(fileOf(h.home).connections[0]).toMatchObject({
      provider: "openai-compatible",
      label: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    r = await h.run("connect", "ollama", "--no-validate");
    expect(r.code).toBe(0);
    expect(fileOf(h.home).connections[1]).toMatchObject({
      id: "ollama-main",
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    r = await h.run("connect", "openai-compatible");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--base-url");
  });

  it("keeps other entries' secret form when adding or replacing", async () => {
    const h = harness({ env: { OTHER: KEY } });
    writeFileSync(
      join(h.home, "connections.json"),
      JSON.stringify({
        version: 1,
        connections: [{ id: "openai-main", provider: "openai", kind: "api-key", secretRef: { env: "OTHER" } }],
      }),
      { mode: 0o600 },
    );
    expect((await h.run("connect", "anthropic", "--api-key", KEY)).code).toBe(0);
    expect((await h.run("connect", "anthropic", "--api-key", `${KEY}2`)).code).toBe(0);
    const f = fileOf(h.home);
    expect(f.connections).toHaveLength(2);
    expect(f.connections[0]).toEqual({
      id: "openai-main",
      provider: "openai",
      kind: "api-key",
      secretRef: { env: "OTHER" },
    });
    expect(f.connections[1]).toMatchObject({ secret: { apiKey: `${KEY}2` } });
  });

  it("rejects unknown providers and --subscription for others", async () => {
    const h = harness();
    expect((await h.run("connect", "acme")).stderr).toContain("unknown provider");
    expect((await h.run("connect", "openai", "--subscription")).stderr).toContain("--subscription");
  });

  it("supports the anthropic subscription and cli runner options", async () => {
    const h = harness();
    expect((await h.run("connect", "anthropic", "--subscription", "--id", "claude-sub")).code).toBe(0);
    expect((await h.run("connect", "anthropic", "--api-key", KEY, "--runner", "cli", "--id", "cc")).code).toBe(0);
    const f = fileOf(h.home);
    expect(f.connections[0]).toMatchObject({ kind: "subscription" });
    const sub = await h.run("connect", "anthropic", "--subscription", "--id", "claude-sub");
    expect(sub.stdout).toContain("secret: none (this record holds no secret)");
    expect(sub.stdout).not.toContain("plaintext");
    expect(f.connections[1]).toMatchObject({ options: { runner: "cli" } });
  });

  it("says keyless local presets hold no secret, even with a master key set", async () => {
    const h = harness({ env: { MERGE_SAFELY_MASTER_KEY: generateMasterKey() } });
    const r = await h.run("connect", "ollama", "--no-validate");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("secret: none (this record holds no secret)");
    expect(r.stdout).not.toContain("encrypted");
  });
});
