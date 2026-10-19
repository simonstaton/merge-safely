import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@merge-safely/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultConnectionsPath,
  inferConnectionKind,
  loadConnectionsFile,
  parseConnectionsInput,
  readConnectionsFile,
  saveConnectionsFile,
} from "./connections.js";
import { encryptSecret, generateMasterKey } from "./crypto.js";

const now = () => new Date("2026-10-19T00:00:00.000Z");
const KEY = "sk-ant-api03-secretvalue-0001";

describe("inferConnectionKind", () => {
  it.each([
    [{ provider: "openai", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "openai-compatible", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "openrouter", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "anthropic", baseUrl: "https://x.test", apiKey: "k" }, "anthropic-compatible"],
    [{ provider: "anthropic", accessToken: "t" }, "oauth"],
    [{ provider: "openai", apiKey: "k" }, "api-key"],
    [{ provider: "openai", apiKeyEnv: "K" }, "api-key"],
    [{ provider: "anthropic", subscription: true }, "subscription"],
    [{ provider: "bedrock", region: "us-east-1" }, "cloud"],
    [{ provider: "anthropic", kind: "oauth" as const, apiKey: "k" }, "oauth"],
  ])("%o -> %s", (input, kind) => {
    expect(inferConnectionKind(input)).toBe(kind);
  });

  it("reports ambiguous or empty input", () => {
    expect(inferConnectionKind({ provider: "anthropic" })).toHaveProperty("error");
    expect(inferConnectionKind({ provider: "anthropic", subscription: true, apiKey: "k" })).toHaveProperty("error");
    expect(inferConnectionKind({ provider: "anthropic", apiKey: "k", accessToken: "t" })).toHaveProperty("error");
  });
});

describe("parseConnectionsInput (inline map)", () => {
  it("parses the design 6.1 shape", () => {
    const env = { OPENROUTER_API_KEY: "or-secret-123456" };
    const r = parseConnectionsInput(
      {
        "anthropic-main": { provider: "anthropic", apiKey: KEY, model: "claude-sonnet-5-5", runner: "cli" },
        router: {
          provider: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
        local: { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
        sub: { provider: "anthropic", subscription: true },
      },
      env,
      { now },
    );
    expect(r.errors).toEqual([]);
    expect(r.connections).toEqual<Connection[]>([
      {
        id: "anthropic-main",
        provider: "anthropic",
        kind: "api-key",
        createdAt: "2026-10-19T00:00:00.000Z",
        defaultModel: "claude-sonnet-5-5",
        options: { runner: "cli" },
        secret: { kind: "api-key", apiKey: KEY },
      },
      {
        id: "router",
        provider: "openai-compatible",
        kind: "openai-compatible",
        createdAt: "2026-10-19T00:00:00.000Z",
        secret: { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-secret-123456" },
      },
      {
        id: "local",
        provider: "ollama",
        kind: "openai-compatible",
        createdAt: "2026-10-19T00:00:00.000Z",
        secret: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      },
      {
        id: "sub",
        provider: "anthropic",
        kind: "subscription",
        createdAt: "2026-10-19T00:00:00.000Z",
        secret: { kind: "subscription" },
      },
    ]);
  });

  it("accepts a JSON string and an oauth token from env", () => {
    const r = parseConnectionsInput(JSON.stringify({ gh: { provider: "github-models", accessTokenEnv: "GH_TOKEN" } }), {
      GH_TOKEN: "ghp_tokenvalue",
    });
    expect(r.errors).toEqual([]);
    expect(r.connections[0]?.secret).toEqual({ kind: "oauth", accessToken: "ghp_tokenvalue" });
  });

  it("reports bad entries by id, keeps the good ones, and never echoes secrets", () => {
    const r = parseConnectionsInput(
      {
        good: { provider: "openai", apiKey: "sk-good-key-123" },
        empty: { provider: "openai", apiKey: "" },
        missingEnv: { provider: "openai", apiKeyEnv: "NOPE_KEY" },
        both: { provider: "openai", apiKey: KEY, apiKeyEnv: "X" },
        unknown: { provider: "openai", apiKey: KEY, bogus: 1 },
        noKind: { provider: "anthropic" },
        "bad id!": { provider: "openai", apiKey: KEY },
        compatNoUrl: { provider: "anthropic", kind: "anthropic-compatible", apiKey: KEY },
        subOpenai: { provider: "openai", subscription: true },
      },
      {},
    );
    expect(r.connections.map((c) => c.id)).toEqual(["good"]);
    const all = r.errors.join("\n");
    expect(all).toContain("connections.empty: apiKey is empty");
    expect(all).toContain("environment variable NOPE_KEY is not set");
    expect(all).toContain("connections.both: give apiKey or apiKeyEnv, not both");
    expect(all).toContain("bogus");
    expect(all).toContain("connections.noKind: cannot infer");
    expect(all).toContain("connection id must be");
    expect(all).toContain("connections.compatNoUrl: baseUrl is required");
    expect(all).toContain("connections.subOpenai: subscription connections are only supported for anthropic");
    expect(all).not.toContain(KEY);
  });

  it("handles empty input", () => {
    expect(parseConnectionsInput(undefined, {})).toEqual({ connections: [], errors: [] });
    expect(parseConnectionsInput("", {})).toEqual({ connections: [], errors: [] });
    expect(parseConnectionsInput("{nope", {}).errors[0]).toContain("not valid JSON");
    expect(parseConnectionsInput([1], {}).errors[0]).toContain("must be an object");
  });
});

describe("parseConnectionsInput (file shape)", () => {
  it("resolves secretRef.env, apiKeyEnv with inline baseUrl, inline secrets and cloud", () => {
    const env = { ANTHROPIC_API_KEY: KEY, OR_KEY: "or-secret-123456" };
    const r = parseConnectionsInput(
      {
        version: 1,
        connections: [
          {
            id: "a",
            provider: "anthropic",
            kind: "api-key",
            secretRef: { env: "ANTHROPIC_API_KEY" },
            createdAt: "2025-01-01",
          },
          {
            id: "r",
            provider: "openai-compatible",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OR_KEY",
          },
          { id: "o", provider: "openai", kind: "api-key", secret: { kind: "api-key", apiKey: "sk-inline-12345" } },
          { id: "b", provider: "bedrock", kind: "cloud", secret: { kind: "cloud", region: "eu-west-1" } },
          { id: "s", provider: "anthropic", kind: "subscription" },
        ],
      },
      env,
      { now },
    );
    expect(r.errors).toEqual([]);
    expect(r.connections.map((c) => c.secret)).toEqual([
      { kind: "api-key", apiKey: KEY },
      { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-secret-123456" },
      { kind: "api-key", apiKey: "sk-inline-12345" },
      { kind: "cloud", region: "eu-west-1" },
      { kind: "subscription" },
    ]);
    expect(r.connections[0]?.createdAt).toBe("2025-01-01");
    expect(r.connections[1]?.createdAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("decrypts secretRef.encrypted with the master key from env, and rejects swapped blobs", () => {
    const mk = generateMasterKey();
    const blob = encryptSecret({ kind: "api-key", apiKey: KEY }, mk, "a");
    const file = {
      version: 1,
      connections: [
        { id: "a", provider: "anthropic", kind: "api-key", secretRef: { encrypted: blob } },
        { id: "b", provider: "anthropic", kind: "api-key", secretRef: { encrypted: blob } },
      ],
    };
    const r = parseConnectionsInput(file, { MERGE_SAFELY_MASTER_KEY: mk });
    expect(r.connections.map((c) => c.id)).toEqual(["a"]);
    expect(r.connections[0]?.secret).toEqual({ kind: "api-key", apiKey: KEY });
    expect(r.errors[0]).toMatch(/^connections\.b: could not decrypt/);
    const noKey = parseConnectionsInput(file, {});
    expect(noKey.errors[0]).toContain("no master key is available");
  });

  it("reports mismatches, duplicates, file refs without a reader, and bad versions", () => {
    const r = parseConnectionsInput(
      {
        version: 2,
        connections: [
          { id: "x", provider: "openai", kind: "oauth", secret: { kind: "api-key", apiKey: KEY } },
          { id: "y", provider: "openai", kind: "api-key", secretRef: { file: "key.txt" } },
          { id: "z", provider: "openai", kind: "api-key", secret: { kind: "api-key", apiKey: KEY } },
          { id: "z", provider: "openai", kind: "api-key", secret: { kind: "api-key", apiKey: KEY } },
          { id: "w", provider: "openai", kind: "api-key" },
          { id: "v", provider: "openai", kind: "api-key", apiKeyEnv: "A", secretRef: { env: "B" } },
          { id: "c", provider: "bedrock", kind: "cloud", secretRef: { env: "B" } },
        ],
      },
      { B: "value-of-b-secret" },
    );
    const all = r.errors.join("\n");
    expect(all).toContain("version: expected 1");
    expect(all).toContain("connections.x: secret kind api-key does not match kind oauth");
    expect(all).toContain("connections.y: secretRef.file is only supported");
    expect(all).toContain("connections.z: duplicate connection id");
    expect(all).toContain("connections.w: no secret");
    expect(all).toContain("connections.v: give only one of");
    expect(all).toContain("connections.c: a plain secret value cannot be used for kind cloud");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("value-of-b-secret");
  });
});

describe("connections file I/O", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ms-conn-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const conns: Connection[] = [
    {
      id: "anthropic-main",
      provider: "anthropic",
      kind: "api-key",
      createdAt: "2026-10-19T00:00:00.000Z",
      defaultModel: "claude-sonnet-5-5",
      secret: { kind: "api-key", apiKey: KEY },
    },
    {
      id: "router",
      provider: "openai-compatible",
      kind: "openai-compatible",
      createdAt: "2026-10-19T00:00:00.000Z",
      secret: { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-secret-123456" },
    },
  ];

  it("defaultConnectionsPath honours MERGE_SAFELY_HOME", () => {
    expect(defaultConnectionsPath({ MERGE_SAFELY_HOME: "/x/y" })).toBe("/x/y/connections.json");
    expect(defaultConnectionsPath({})).toMatch(/\.merge-safely\/connections\.json$/);
  });

  it("encrypted save/load round trip; no plaintext on disk; mode 0600", async () => {
    const mk = generateMasterKey();
    const path = join(dir, "nested", "connections.json");
    const res = await saveConnectionsFile(path, conns, { masterKey: mk });
    expect(res.warnings).toEqual([]);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("or-secret");
    expect(text).not.toContain("openrouter.ai");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConnectionsFile(path, {}, { masterKey: mk })).toEqual(conns);
    expect(await loadConnectionsFile(path, { MERGE_SAFELY_MASTER_KEY: mk })).toEqual(conns);
    await expect(loadConnectionsFile(path, { MERGE_SAFELY_MASTER_KEY: generateMasterKey() })).rejects.toThrow(
      /could not decrypt/,
    );
  });

  it("writes env references when asked, and plaintext with a warning otherwise", async () => {
    const path = join(dir, "connections.json");
    const res = await saveConnectionsFile(path, conns, { envRefs: { "anthropic-main": "ANTHROPIC_API_KEY" } });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("connection router: secret stored in plaintext (file mode 0600)");
    expect(res.warnings[0]).not.toContain("or-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const json = JSON.parse(await readFile(path, "utf8")) as { connections: Record<string, unknown>[] };
    expect(json.connections[0]?.secretRef).toEqual({ env: "ANTHROPIC_API_KEY" });
    expect(json.connections[0]?.secret).toBeUndefined();
    const loaded = await loadConnectionsFile(path, { ANTHROPIC_API_KEY: KEY });
    expect(loaded).toEqual(conns);
    await expect(loadConnectionsFile(path, {})).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("writes compatible kinds with an env ref as inline baseUrl + secretRef.env", async () => {
    const path = join(dir, "connections.json");
    await saveConnectionsFile(path, [conns[1] as Connection], { envRefs: { router: "OR_KEY" } });
    const json = JSON.parse(await readFile(path, "utf8")) as { connections: Record<string, unknown>[] };
    expect(json.connections[0]).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      secretRef: { env: "OR_KEY" },
    });
    expect(await loadConnectionsFile(path, { OR_KEY: "or-secret-123456" })).toEqual([conns[1]]);
  });

  it("resolves secretRef.file relative to the connections file (plain and JSON)", async () => {
    await writeFile(join(dir, "key.txt"), `${KEY}\n`);
    await writeFile(
      join(dir, "oauth.json"),
      JSON.stringify({ kind: "oauth", accessToken: "tok-1234567", refreshToken: "r" }),
    );
    const path = join(dir, "connections.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        connections: [
          { id: "a", provider: "anthropic", kind: "api-key", secretRef: { file: "key.txt" } },
          { id: "o", provider: "anthropic", kind: "oauth", secretRef: { file: join(dir, "oauth.json") } },
          { id: "m", provider: "anthropic", kind: "api-key", secretRef: { file: "missing.txt" } },
        ],
      }),
      { mode: 0o644 },
    );
    const r = await readConnectionsFile(path, {});
    expect(r.connections.map((c) => c.secret)).toEqual([
      { kind: "api-key", apiKey: KEY },
      { kind: "oauth", accessToken: "tok-1234567", refreshToken: "r" },
    ]);
    expect(r.errors).toEqual(["connections.m: could not read secret file missing.txt"]);
    expect(r.warnings[0]).toContain("readable by other users");
  });

  it("missing default file yields []; missing explicit file and bad JSON throw", async () => {
    expect(await loadConnectionsFile(undefined, { MERGE_SAFELY_HOME: dir })).toEqual([]);
    await expect(loadConnectionsFile(join(dir, "nope.json"), {})).rejects.toThrow(/not found/);
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{");
    await expect(loadConnectionsFile(bad, {})).rejects.toThrow(/not valid JSON/);
  });

  it("refuses duplicate ids on save", async () => {
    await expect(
      saveConnectionsFile(join(dir, "c.json"), [conns[0] as Connection, conns[0] as Connection]),
    ).rejects.toThrow(/duplicate connection id/);
  });
});
