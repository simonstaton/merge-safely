import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@merge-safely/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultConnectionsPath,
  loadConnectionsFile,
  parseConnectionsInput,
  readConnectionsFile,
  saveConnectionsFile,
} from "./connections.js";
import { encryptSecret, generateMasterKey } from "./crypto.js";
import { inferConnectionKind } from "./kinds.js";

const now = () => new Date("2026-10-19T00:00:00.000Z");
const KEY = "sk-ant-api03-secretvalue-0001";

describe("inferConnectionKind", () => {
  it.each([
    [{ provider: "openai", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "openai-compatible", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "openrouter", baseUrl: "https://x.test/v1" }, "openai-compatible"],
    [{ provider: "groq", apiKey: "k" }, "openai-compatible"],
    [{ provider: "ollama" }, "openai-compatible"],
    [{ provider: "bedrock" }, "cloud"],
    [{ provider: "anthropic", subscription: false, apiKey: "k" }, "api-key"],
    [{ provider: "anthropic", baseUrl: "https://x.test", apiKey: "k" }, "anthropic-compatible"],
    [{ provider: "anthropic", accessToken: "t" }, "oauth"],
    [{ provider: "openai", apiKey: "k" }, "api-key"],
    [{ provider: "openai", apiKeyEnv: "K" }, "api-key"],
    [{ provider: "anthropic", subscription: true }, "subscription"],
    [{ provider: "bedrock", region: "us-east-1" }, "cloud"],
    [{ provider: "anthropic", kind: "oauth" as const, accessToken: "t" }, "oauth"],
    [{ provider: "openai", kind: "openai-compatible" as const, apiKey: "k" }, "openai-compatible"],
  ])("%o -> %s", (input, kind) => {
    expect(inferConnectionKind(input)).toBe(kind);
  });

  it.each([
    [{ provider: "azure-openai", baseUrl: "https://x.test", apiKey: "k" }, /azure-openai connections are kind cloud/],
    [{ provider: "bedrock", baseUrl: "https://x.test" }, /take no baseUrl/],
    [
      { provider: "anthropic", baseUrl: "https://x.test", subscription: true, apiKey: "k" },
      /cannot be combined with baseUrl, apiKey/,
    ],
    [{ provider: "anthropic", subscription: true, accessTokenEnv: "T" }, /cannot be combined with accessTokenEnv/],
    [
      { provider: "anthropic", subscription: true, apiKey: "" },
      /apiKey is empty; a subscription connection takes no apiKey/,
    ],
    [{ provider: "openai", kind: "subscription" as const }, /provider openai does not support kind subscription/],
    [{ provider: "bedrock", kind: "api-key" as const, apiKey: "k" }, /bedrock does not support kind api-key/],
    [{ provider: "openrouter", kind: "api-key" as const, apiKey: "k" }, /does not support kind api-key/],
  ])("rejects conflicting signals %o", (input, message) => {
    const r = inferConnectionKind(input);
    expect(typeof r === "object" ? r.error : r).toMatch(message);
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
    expect(all).toContain("connections.subOpenai: provider openai does not support kind subscription");
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

describe("parseConnectionsInput (strict fields and gateways)", () => {
  it("rejects fields the chosen kind does not use, listing them", () => {
    const r = parseConnectionsInput(
      {
        tok: { provider: "openai", baseUrl: "https://x.test/v1", accessToken: "tok-1234567" },
        key: { provider: "openai", kind: "api-key", apiKey: "k-1234567", headers: { a: "b" }, accessTokenEnv: "T" },
        reg: { provider: "openai", apiKey: "k-1234567", region: "us-east-1" },
        refresh: { provider: "anthropic", apiKey: "k-1234567", refreshToken: "r" },
        cred: { provider: "openai", apiKey: "k-1234567", credentialFileRef: "/x" },
      },
      {},
    );
    expect(r.connections).toEqual([]);
    expect(r.errors).toEqual([
      "connections.tok: accessToken not used by kind openai-compatible; remove or fix",
      "connections.key: headers, accessTokenEnv not used by kind api-key; remove or fix",
      "connections.reg: region not used by kind api-key; remove or fix",
      "connections.refresh: refreshToken not used by kind api-key; remove or fix",
      "connections.cred: credentialFileRef not used by kind api-key; remove or fix",
    ]);
    expect(r.errors.join("\n")).not.toContain("tok-1234567");
  });

  it("normalises gateway names to openai-compatible, keeping the name as label and filling a default baseUrl", () => {
    const r = parseConnectionsInput(
      {
        or: { provider: "openrouter", apiKeyEnv: "OR" },
        gq: { provider: "groq", apiKey: "gsk-123456", label: "Groq prod" },
        vl: { provider: "vllm", baseUrl: "http://gpu:8000/v1" },
        vlNoUrl: { provider: "vllm" },
        ol: { provider: "ollama" },
      },
      { OR: "or-secret-123456" },
      { now },
    );
    expect(r.errors).toEqual(["connections.vlNoUrl: baseUrl is required for kind openai-compatible"]);
    expect(r.connections.map((c) => [c.id, c.provider, c.label, c.secret])).toEqual([
      [
        "or",
        "openai-compatible",
        "openrouter",
        { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-secret-123456" },
      ],
      [
        "gq",
        "openai-compatible",
        "Groq prod",
        { kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-123456" },
      ],
      ["vl", "openai-compatible", "vllm", { kind: "openai-compatible", baseUrl: "http://gpu:8000/v1" }],
      ["ol", "ollama", undefined, { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" }],
    ]);
  });

  it("normalises gateways and checks kinds in file entries", () => {
    const r = parseConnectionsInput(
      {
        version: 1,
        connections: [
          { id: "or", provider: "openrouter", kind: "openai-compatible", apiKeyEnv: "OR" },
          { id: "bad", provider: "bedrock", kind: "api-key", apiKeyEnv: "OR" },
          { id: "url", provider: "openai", kind: "api-key", baseUrl: "https://x.test", apiKeyEnv: "OR" },
          {
            id: "enc",
            provider: "openai",
            kind: "openai-compatible",
            baseUrl: "https://x.test",
            secretRef: { encrypted: "v1:x" },
          },
        ],
      },
      { OR: "or-secret-123456" },
    );
    expect(r.connections.map((c) => [c.provider, c.label, c.secret])).toEqual([
      [
        "openai-compatible",
        "openrouter",
        { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-secret-123456" },
      ],
    ]);
    expect(r.errors).toEqual([
      "connections.bad: provider bedrock does not support kind api-key (supported: cloud)",
      "connections.url: baseUrl not used by kind api-key; remove or fix",
      "connections.enc: baseUrl/headers are ignored next to an encrypted secret; remove them",
    ]);
  });

  it("says YAML must be parsed at the edge", () => {
    const r = parseConnectionsInput("anthropic-main: { provider: anthropic, apiKey: sk-ant-xyz-123 }", {});
    expect(r.errors).toEqual([
      "connections input is a string but not valid JSON; YAML must be parsed at the edge; pass the parsed object",
    ]);
  });
});

describe("connections file I/O (hardening)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ms-conn2-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const compat = (baseUrl: string): Connection => ({
    id: "gw",
    provider: "openai-compatible",
    kind: "openai-compatible",
    createdAt: "2026-10-19T00:00:00.000Z",
    secret: { kind: "openai-compatible", baseUrl, apiKey: "k-1234567890" },
  });

  it("warns when a baseUrl with credentials is saved next to an env ref", async () => {
    const path = join(dir, "c.json");
    const r = await saveConnectionsFile(path, [compat("https://user:hunter2pass@gw.test/v1?api-key=qsecret123")], {
      envRefs: { gw: "GW_KEY" },
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("baseUrl contains credentials");
    expect(r.warnings[0]).not.toContain("hunter2pass");
    const ok = await saveConnectionsFile(path, [compat("https://gw.test/v1")], { envRefs: { gw: "GW_KEY" } });
    expect(ok.warnings).toEqual([]);
  });

  it("tightens an existing merge-safely home dir to 0700 and only warns for other dirs", async () => {
    const { chmod, mkdir } = await import("node:fs/promises");
    const home = join(dir, ".merge-safely");
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    const r1 = await saveConnectionsFile(join(home, "connections.json"), [], { env: {} });
    expect(r1.warnings).toEqual([]);
    expect((await stat(home)).mode & 0o777).toBe(0o700);

    const custom = join(dir, "custom");
    await mkdir(custom, { mode: 0o755 });
    await chmod(custom, 0o755);
    const r2 = await saveConnectionsFile(join(custom, "connections.json"), [], { env: {} });
    expect(r2.warnings[0]).toContain("accessible by other users");
    expect((await stat(custom)).mode & 0o777).toBe(0o755);

    const viaEnv = join(dir, "msh");
    await mkdir(viaEnv, { mode: 0o755 });
    await chmod(viaEnv, 0o755);
    await saveConnectionsFile(join(viaEnv, "connections.json"), [], { env: { MERGE_SAFELY_HOME: viaEnv } });
    expect((await stat(viaEnv)).mode & 0o777).toBe(0o700);
  });

  it("writes through a symlinked connections file", async () => {
    const { symlink, lstat } = await import("node:fs/promises");
    const real = join(dir, "real.json");
    await writeFile(real, '{"version":1,"connections":[]}');
    const link = join(dir, "link.json");
    await symlink(real, link);
    await saveConnectionsFile(link, [compat("https://gw.test/v1")], { envRefs: { gw: "GW_KEY" } });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toContain("GW_KEY");
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  it("expands ~ in secretRef.file", async () => {
    const { resolveSecretPath } = await import("./connections.js");
    const { homedir } = await import("node:os");
    expect(resolveSecretPath("~/k.txt", "/base")).toBe(join(homedir(), "k.txt"));
    expect(resolveSecretPath("k.txt", "/base")).toBe("/base/k.txt");
    expect(resolveSecretPath("/abs/k.txt", "/base")).toBe("/abs/k.txt");
  });
});

describe("local providers keep their own id", () => {
  it("lmstudio is not renamed to openai-compatible and gets its default base URL", () => {
    const r = parseConnectionsInput({ lm: { provider: "lmstudio" } }, {});
    expect(r.errors).toEqual([]);
    expect(r.connections[0]?.provider).toBe("lmstudio");
    expect(r.connections[0]?.kind).toBe("openai-compatible");
    const secret = r.connections[0]?.secret;
    expect(secret?.kind === "openai-compatible" && secret.baseUrl).toBe("http://localhost:1234/v1");
  });
});
