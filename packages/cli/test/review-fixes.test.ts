/** Tests for the PR #14 review findings. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY, tier } from "@merge-safely/core";
import { createProviderRegistry, generateMasterKey } from "@merge-safely/providers";
import { fakeModel, scenarios, fakeProvider as tkProvider } from "@merge-safely/testkit";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/exec.js";
import { realGateFactory } from "../src/gate.js";
import { buildLocalChange } from "../src/local-source.js";
import { tokenIdentity } from "../src/token.js";
import { fakeProvider, harness, tempDir } from "./helpers.js";

const KEY = "sk-ant-api03-supersecretvalue-XYZ9";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

function repo(): string {
  const dir = tempDir("ms-fix-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Ada");
  git(dir, "config", "user.email", "ada@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function writeConnections(home: string, connections: unknown[]): void {
  writeFileSync(join(home, "connections.json"), JSON.stringify({ version: 1, connections }), { mode: 0o600 });
}

const fakeConn = (id = "fake-main") => ({
  id,
  provider: "fake",
  kind: "api-key",
  secret: { kind: "api-key", apiKey: `fake-key-${id}-0123456789` },
});

describe("1. run --local never silently drops changed files", () => {
  it("includes every untracked file, and past the size cap omits (not drops) files and fails closed to tier 3", async () => {
    const dir = repo();
    writeFileSync(join(dir, "aaa_big.txt"), `${"x".repeat(200)}\n`.repeat(20_000)); // ~4 MB, sorts first
    mkdirSync(join(dir, "docs"));
    for (let i = 0; i < 251; i++) writeFileSync(join(dir, "docs", `n${String(i).padStart(3, "0")}.md`), `note ${i}\n`);
    const lc = await buildLocalChange({ exec: execCommand, cwd: dir, base: "main" });
    expect(lc.change.stats.files).toBe(252);
    expect(lc.omitted).toEqual(["aaa_big.txt"]);
    expect(lc.change.files).toHaveLength(251);
    expect(lc.change.stats.files).toBeGreaterThan(lc.change.files.length);
    expect(tier(lc.change, DEFAULT_POLICY).level).toBe(3);

    const h = harness({ cwd: dir, exec: execCommand });
    writeConnections(h.home, [fakeConn()]);
    const r = await h.run("run", "--local", "--base", "main");
    expect(r.stderr).toMatch(/1 changed file left out of the review .*aaa_big\.txt.*tier 3/);
    const input = h.gate.calls[0]?.arg as { change: { files: unknown[]; stats: { files: number } } };
    expect(input.change.files).toHaveLength(251);
    expect(input.change.stats.files).toBe(252);
  });

  it("rejects PR-only flags with --local", async () => {
    const h = harness({ cwd: repo(), exec: execCommand });
    for (const flags of [
      ["--report", "json"],
      ["--store", "fs"],
      ["--dry-run"],
      ["--head", "a".repeat(40)],
      ["--slack-webhook", "https://hooks.slack.com/x"],
    ]) {
      const r = await h.run("run", "--local", ...flags);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/error \[USAGE\]: --local cannot be combined with --/);
    }
  });
});

describe("4. connections without a secret are never encrypted", () => {
  it("stores subscription and keyless local connections as plain records with a master key set", async () => {
    const h = harness({ env: { MERGE_SAFELY_MASTER_KEY: generateMasterKey() } });
    expect((await h.run("connect", "anthropic", "--subscription", "--id", "claude-sub")).code).toBe(0);
    expect((await h.run("connect", "ollama", "--no-validate")).code).toBe(0);
    expect((await h.run("connect", "anthropic", "--api-key", KEY)).code).toBe(0);
    const f = JSON.parse(readFileSync(join(h.home, "connections.json"), "utf8")) as {
      connections: Record<string, unknown>[];
    };
    expect(f.connections[0]).toMatchObject({ id: "claude-sub", secret: { kind: "subscription" } });
    expect(f.connections[0]?.secretRef).toBeUndefined();
    expect(f.connections[1]).toEqual(
      expect.objectContaining({ id: "ollama-main", baseUrl: "http://localhost:11434/v1" }),
    );
    expect(f.connections[1]?.secretRef).toBeUndefined();
    expect(f.connections[2]?.secretRef).toHaveProperty("encrypted");
    // They load (and list) without the master key.
    const noKey = harness();
    noKey.ctx.env.MERGE_SAFELY_HOME = h.home;
    const r = await noKey.run("--home", h.home, "connections", "list");
    expect(r.stdout).toMatch(/claude-sub .* login/);
    expect(r.stdout).toMatch(/ollama-main .* no key/);
  });
});

describe("5. connections test reports entries that fail to load", () => {
  it("lists unloadable entries as FAIL (exit 2), and only says 'no connections' for an empty file", async () => {
    const h = harness({ env: { PRESENT: KEY } });
    writeConnections(h.home, [
      { id: "ok-one", provider: "anthropic", kind: "api-key", secretRef: { env: "PRESENT" } },
      { id: "env-missing", provider: "anthropic", kind: "api-key", secretRef: { env: "NOT_SET_ANYWHERE" } },
      { id: "locked", provider: "anthropic", kind: "api-key", secretRef: { encrypted: "abc" } },
    ]);
    let r = await h.run("connections", "test");
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/ok\s+ok-one/);
    expect(r.stdout).toMatch(/FAIL\s+env-missing\s+could not load: .*NOT_SET_ANYWHERE/);
    expect(r.stdout).toMatch(/FAIL\s+locked\s+could not load: .*master key/);
    r = await h.run("connections", "test", "env-missing");
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/FAIL\s+env-missing/);
    r = await h.run("--json", "connections", "test");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
    writeConnections(h.home, []);
    r = await h.run("connections", "test");
    expect(r.stderr).toContain("error [NO_CONNECTIONS]");
  });
});

describe("7. run fails fast on a dead connection", () => {
  function deadSetup(policy?: string) {
    const dir = repo();
    writeFileSync(join(dir, "src.ts"), Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
    if (policy) writeFileSync(join(dir, ".merge-safely.yml"), policy);
    const dead = tkProvider({ id: "dead", validate: { ok: false, message: "connect ECONNREFUSED 127.0.0.1:9" } });
    const live = tkProvider({ id: "fake", script: scenarios.allPass() });
    const h = harness({ cwd: dir, exec: execCommand });
    writeConnections(h.home, [{ ...fakeConn("dead-one"), provider: "dead" }, fakeConn("live-one")]);
    h.ctx.gateFactory = realGateFactory(() => createProviderRegistry([dead, live]));
    return { h, dead, live };
  }

  it("names the connection and the fix when the policy uses it", async () => {
    const { h, dead } = deadSetup("models:\n  hunters: { connection: dead-one, model: fake-model }\n");
    const r = await h.run("run", "--local", "--base", "main");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(
      /error \[CONNECTION_UNREACHABLE\]: connection dead-one .*ECONNREFUSED.*connections test dead-one/,
    );
    expect(dead.calls).toHaveLength(0);
  });

  it("drops it with a warning under automatic model choice and reviews with the live one", async () => {
    const { h, live } = deadSetup();
    const r = await h.run("run", "--local", "--base", "main");
    expect(r.stderr).toContain("connection dead-one skipped");
    expect(r.code).toBe(0);
    expect(live.calls.length).toBeGreaterThan(0);
  });
});

describe("8. connect's cost table shows what seating will pick", () => {
  it("prices --model on an unvalidated compatible connection, matching estimate's seating", async () => {
    const dir = repo();
    writeFileSync(join(dir, "src.ts"), Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
    const compat = tkProvider({ id: "openai-compatible", connectionKinds: ["openai-compatible"], models: [] });
    const h = harness({ cwd: dir, exec: execCommand, provider: fakeProvider(), extraProviders: [compat] });
    let r = await h.run(
      "connect",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:9/v1",
      "--model",
      "qwen2.5-coder",
      "--no-validate",
      "--id",
      "gw",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/tier 1 .* qwen2\.5-coder .* qwen2\.5-coder/);
    expect(r.stdout).not.toContain("gpt-5");
    h.ctx.gateFactory = realGateFactory(() => createProviderRegistry([compat]));
    r = await h.run("estimate", "--local", "--base", "main");
    expect(r.stdout).toContain("qwen2.5-coder");
  });

  it("uses the repo policy's models.* when they name this connection, and says when --model is not what seating uses", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".merge-safely.yml"),
      "models:\n  hunters: { connection: anthropic-main, model: claude-sonnet-5-5 }\n  judges: { connection: anthropic-main, model: claude-sonnet-5-5 }\n",
    );
    const h = harness({ cwd: dir });
    let r = await h.run("connect", "anthropic", "--api-key", KEY);
    expect(r.stdout).toMatch(/tier 3 .*claude-sonnet-5-5 .*claude-sonnet-5-5/);
    expect(r.stdout).toContain(".merge-safely.yml");
    const h2 = harness();
    r = await h2.run("connect", "anthropic", "--api-key", KEY, "--model", "claude-opus-5-5");
    expect(r.stdout).toContain("--model claude-opus-5-5 is only used when");
  });

  it("says 'unreachable' rather than 'fix the key' for network failures", async () => {
    const h = harness({
      provider: fakeProvider({ validate: () => ({ ok: false, message: "fetch failed: getaddrinfo ENOTFOUND x" }) }),
    });
    const r = await h.run("connect", "anthropic", "--api-key", KEY);
    expect(r.stderr).toContain("unreachable: check the base URL and your network");
    expect(r.stderr).not.toContain("fix the key");
  });
});

describe("9. default store follows the token", () => {
  it("uses checkrun for App/Actions tokens and fs otherwise, and says which", async () => {
    const app = harness({ env: { GITHUB_TOKEN: "ghs_installationtoken1234567890" } });
    writeConnections(app.home, [fakeConn()]);
    let r = await app.run("run", "--repo", "acme/app", "--pr", "7");
    expect(app.gate.setups[0]?.target).toMatchObject({ store: "checkrun", report: "github" });
    expect(r.stderr).toContain("store: checkrun");
    const user = harness({ env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", GITHUB_ACTIONS: "true" } });
    writeConnections(user.home, [fakeConn()]);
    r = await user.run("run", "--repo", "acme/app", "--pr", "7");
    expect(user.gate.setups[0]?.target).toMatchObject({ store: "fs", report: "status", tokenIdentity: "user" });
    expect(r.stderr).toContain("store: fs");
  });
});

describe("10. SIGINT / SIGTERM", () => {
  it("cancels a PR review, completes the check run with an error, and exits 130", async () => {
    const { fakeOctokit } = await import("./fake-octokit.js");
    const { fakeWorkspace } = await import("@merge-safely/testkit");
    const headSha = "1".repeat(40);
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`);
    const gh = fakeOctokit({
      headSha,
      baseSha: "2".repeat(40),
      files: [
        {
          filename: "src/a.ts",
          status: "added",
          additions: 45,
          deletions: 0,
          patch: `@@ -0,0 +1,45 @@\n${body.map((l) => `+${l}`).join("\n")}`,
        },
      ],
    });
    const provider = tkProvider({ id: "fake", models: [fakeModel()], delayMs: 60_000 });
    const h = harness({ env: { GITHUB_TOKEN: "ghs_installation0123456789abcdef" } });
    h.github.pull = { headSha, baseRef: "main", baseSha: "2".repeat(40) };
    writeConnections(h.home, [fakeConn()]);
    const ws = fakeWorkspace({ files: { "src/a.ts": `${body.join("\n")}\n` } });
    h.ctx.gateFactory = realGateFactory(() => createProviderRegistry([provider]), {
      octokit: () => gh.octokit,
      workspace: () => ws,
    });
    let fire: ((s: string) => void) | undefined;
    h.ctx.onSignal = (handler) => {
      fire = handler;
      return () => {
        fire = undefined;
      };
    };
    const running = h.run("run", "--repo", "acme/app", "--pr", "7");
    for (let i = 0; i < 200 && ws.acquired === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(gh.state.checkRuns[0]?.status).toBe("in_progress");
    expect(ws.acquired).toBeGreaterThan(0);
    fire?.("SIGINT");
    const r = await running;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("SIGINT received");
    const run = gh.state.checkRuns[0];
    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("failure");
    expect(run?.output.summary ?? "").toContain("interrupted");
    // A seat whose checkout was still being created when the signal arrived is disposed as soon as it lands.
    for (let i = 0; i < 80 && ws.disposed < ws.acquired; i++) await new Promise((r) => setTimeout(r, 25));
    expect(ws.disposed).toBe(ws.acquired);
  });
});

describe("nits", () => {
  it("a PAT in GITHUB_TOKEN inside Actions is a user token", () => {
    expect(tokenIdentity({ token: "ghp_x", source: "GITHUB_TOKEN" }, { GITHUB_ACTIONS: "true" })).toBe("user");
    expect(tokenIdentity({ token: "github_pat_x", source: "GITHUB_TOKEN" }, { GITHUB_ACTIONS: "true" })).toBe("user");
  });

  it("nested --help works after a global value flag", async () => {
    const h = harness();
    for (const args of [
      ["connections", "list"],
      ["policy", "lint"],
    ]) {
      const r = await h.run("--home", h.home, ...args, "--help");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Usage: merge-safely ${args.join(" ")}`);
    }
  });

  it("--verbose never prints a plaintext key", async () => {
    const h = harness();
    let r = await h.run("--verbose", "connect", "anthropic", "--api-key", KEY);
    expect(r.stdout + r.stderr).not.toContain(KEY);
    r = await h.run("--verbose", "connections", "test");
    expect(r.stdout + r.stderr).not.toContain(KEY);
    r = await h.run("--verbose", "--json", "connections", "list");
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  it("tightens an existing home directory to 0700", async () => {
    const h = harness();
    chmodSync(h.home, 0o755);
    await h.run("connect", "anthropic", "--api-key", KEY);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
  });

  it("eval --dry never runs gh auth token", async () => {
    const calls: string[] = [];
    const h = harness({
      exec: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    h.ctx.octokit = () => {
      throw new Error("no client expected");
    };
    const r = await h.run(
      "--json",
      "eval",
      "--suite",
      join(import.meta.dirname, "../../evals/suites/starter"),
      "--dry",
    );
    expect(r.code).toBe(0);
    expect(calls.filter((c) => c.startsWith("gh"))).toEqual([]);
    expect(JSON.parse(r.stdout)).toHaveProperty("summary");
  });
});
