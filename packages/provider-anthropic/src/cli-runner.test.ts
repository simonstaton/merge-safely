import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../test/fake-claude.js";
import { API_KEY, conn, input, model, seat, ws } from "../test/helpers.js";
import { buildCliEnv, ClaudeCodeRunner, cliAllowedTools } from "./cli-runner.js";
import { REDACTED } from "./secrets.js";

const fixture = (n: string) => fileURLToPath(new URL(`../test/fixtures/${n}`, import.meta.url));
const workdir = () => mkdtempSync(join(tmpdir(), "ms-ws-"));

const assistant = (id: string, blocks: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    message: { id, role: "assistant", content: blocks, usage: { input_tokens: 5, output_tokens: 5 } },
  });
const ok = (id: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }] },
  });
const result = (r: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 },
    ...r,
  });
const PASS = { verdict: "pass", summary: "ok", findings: [] };
const runWith = (
  fake: { binary: string },
  over: { cwd?: string; budget?: Partial<ReturnType<typeof seat>["budget"]> } = {},
) =>
  new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary, killGraceMs: 200 }).run(
    seat({}, over.budget ?? {}),
    input(),
    ws(over.cwd ?? workdir()),
  );

describe("ClaudeCodeRunner", () => {
  it("passes with tool uses from a real transcript, with hardened flags", async () => {
    const cwd = workdir();
    const fake = fakeClaude({ fixture: fixture("pass-structured.jsonl"), replace: { from: "/workspace", to: cwd } });
    const onUsage = vi.fn();
    const r = new ClaudeCodeRunner(conn(), model({ name: "claude-haiku-5-5" }), { onUsage }, { binary: fake.binary });
    const run = await r.run(seat(), input({ allowedCommands: ["npm test", "rm -rf / ; echo"] }), ws(cwd));

    expect(run.status).toBe("ok");
    expect(run.output).toMatchObject({ verdict: "pass", summary: "hello world" });
    expect(run.audit).toMatchObject({ filesRead: ["a.txt"], substantiveCalls: 1, turns: 3 });
    expect(run.audit.costUsd).toBeGreaterThan(0);
    expect(onUsage).toHaveBeenCalledTimes(1);

    const rec = fake.record();
    expect(rec.stdin).toBe("Review this diff.");
    const a = rec.argv;
    const flag = (f: string) => a[a.indexOf(f) + 1];
    expect(a[0]).toBe("-p");
    expect(flag("--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(flag("--model")).toBe("claude-haiku-5-5");
    expect(flag("--max-turns")).toBe("10");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--setting-sources")).toBe("");
    expect(a).toEqual(
      expect.arrayContaining(["--strict-mcp-config", "--safe-mode", "--restricted", "--no-session-persistence"]),
    );
    expect(a).not.toContain("--append-system-prompt");
    expect(flag("--system-prompt")).toContain("You are the correctness lens.");
    expect(flag("--system-prompt")).toContain("ms-git");
    expect(flag("--disallowedTools")).toContain("Edit");
    expect(flag("--disallowedTools")).toContain("WebFetch");
    expect(flag("--disallowedTools")).toContain("Bash(git:*)");
    expect(flag("--allowedTools")).toBe("Read,Grep,Glob,LS,Bash(ms-git:*),Bash(npm test:*)");
    expect(JSON.parse(flag("--json-schema") ?? "{}").required).toEqual(["verdict", "summary", "findings"]);
    expect(a).not.toContain("--max-budget-usd");
    // The launcher on PATH pins the workspace and runs the compiled wrapper.
    expect(rec.msGit).toContain(`MS_GIT_CWD='${cwd}'`);
    expect(rec.msGit).toContain("git-wrapper.js");
  });

  it("reports a block with findings and observed commands", async () => {
    const block = {
      verdict: "block",
      summary: "N+1 query",
      findings: [
        {
          severity: "blocker",
          class: "n-plus-one",
          title: "Query in loop",
          detail: "Each row queries.",
          file: "src/a.ts",
          line: 3,
        },
      ],
    };
    const cwd = workdir();
    const fake = fakeClaude({
      lines: [
        assistant("m1", [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: join(cwd, "src/a.ts") } },
          { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "query" } },
        ]),
        ok("t1"),
        ok("t2"),
        assistant("m2", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ms-git diff HEAD~1" } }]),
        ok("t3"),
        result({ structured_output: block, result: JSON.stringify(block) }),
      ],
    });
    const run = await runWith(fake, { cwd });
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(run.output?.findings[0]).toMatchObject({ severity: "blocker", class: "n-plus-one" });
    expect(run.audit).toMatchObject({
      filesRead: ["src/a.ts"],
      commandsRun: ["ms-git diff HEAD~1"],
      substantiveCalls: 3,
      totalCalls: 3,
    });
    expect(run.audit.tokens).toEqual({ in: 100, out: 50, cachedIn: 10, cacheWrite: 20 });
    expect(run.audit.costUsd).toBeCloseTo(0.0123, 6);
    expect(fake.record().cwd).toBe(cwd);
  });

  it("classifies max-turns as budget-exceeded, not error", async () => {
    const cwd = workdir();
    const fake = fakeClaude({
      fixture: fixture("max-turns.jsonl"),
      exitCode: 1,
      replace: { from: "/workspace", to: cwd },
    });
    const run = await runWith(fake, { cwd, budget: { maxTurns: 1 } });
    expect(run.status).toBe("budget-exceeded");
    expect(run.error).toContain("budget.seatMaxTurns");
    expect(run.output).toBeNull();
    expect(run.audit.filesRead).toEqual(["a.txt"]);
    // The real transcript's `git log` failed (exit 128), so it is not counted.
    expect(run.audit.commandsRun).toEqual([]);
  });

  it("classifies the CLI's own USD budget stop and passes --max-budget-usd", async () => {
    const fake = fakeClaude({
      lines: [result({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.51 })],
      exitCode: 1,
    });
    const run = await runWith(fake, { budget: { maxUsd: 0.5 } });
    expect(run.status).toBe("budget-exceeded");
    expect(run.error).toContain("budget.perSeatUsd");
    const a = fake.record().argv;
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  it("treats an unrelated non-zero exit as error, never budget-exceeded", async () => {
    const fake = fakeClaude({
      lines: [result({ subtype: "error_during_execution", is_error: true, num_turns: 3 })],
      stderr: `Error: 401 authentication failed for ${API_KEY}\n`,
      exitCode: 1,
    });
    const run = await runWith(fake, { budget: { maxTurns: 3 } });
    expect(run.status).toBe("error");
    expect(run.error).not.toContain(API_KEY);
  });

  it("is schema-invalid when the result is not valid JSON", async () => {
    const run = await runWith(fakeClaude({ lines: [result({ result: "Looks good to me!" })] }));
    expect(run.status).toBe("schema-invalid");
    expect(run.output).toBeNull();
    const run2 = await runWith(fakeClaude({ lines: [result({ result: '{"verdict":"maybe"}' })] }));
    expect(run2.status).toBe("schema-invalid");
    expect(run2.error).toContain("verdict");
  });

  it("kills on deadline (SIGTERM then SIGKILL) and reports timeout with streamed usage", async () => {
    const fake = fakeClaude({
      lines: [assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } }]), ok("t1")],
      sleepMs: 30_000,
      ignoreTerm: true,
    });
    const onUsage = vi.fn();
    const t0 = Date.now();
    const run = await new ClaudeCodeRunner(conn(), model(), { onUsage }, { binary: fake.binary, killGraceMs: 200 }).run(
      seat({}, { deadlineMs: 400 }),
      input(),
      ws(workdir()),
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(run.status).toBe("timeout");
    expect(run.audit.filesRead).toEqual(["x.ts"]);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ in: 5, out: 5 }) }),
    );
  });

  it("keeps a timeout even when a valid result arrived before the kill", async () => {
    const fake = fakeClaude({ lines: [result({ structured_output: PASS })], sleepMs: 30_000 });
    const run = await runWith(fake, { budget: { deadlineMs: 300 } });
    expect(run.status).toBe("timeout");
    expect(run.output).toBeNull();
  });

  it("never trusts a forged success result followed by a signal death", async () => {
    const fake = fakeClaude({
      lines: [
        assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }]),
        ok("t1"),
        result({ structured_output: PASS }),
      ],
      selfSignal: "SIGKILL",
    });
    const run = await runWith(fake);
    expect(run.status).toBe("error");
    expect(run.output).toBeNull();
    expect(run.error).toContain("SIGKILL");
  });

  it("discards a result event that is not the last event", async () => {
    const fake = fakeClaude({
      lines: [result({ structured_output: PASS }), assistant("m9", [{ type: "text", text: "still going" }])],
    });
    const run = await runWith(fake);
    expect(run.status).toBe("error");
    expect(run.output).toBeNull();
    expect(run.error).toContain("discarded");
  });

  it("scrubs secrets from the review output before returning it", async () => {
    process.env.MS_TEST_GATE_TOKEN = "gate-env-token-value-123";
    try {
      const leaky = {
        verdict: "block",
        summary: `found ${API_KEY} in ~/.claude and gate-env-token-value-123`,
        findings: [
          {
            severity: "blocker",
            class: "secret-leak",
            title: "token ghp_0123456789abcdefghijABCDEFGHIJ",
            detail: "AKIAABCDEFGHIJKLMNOP",
            evidence: ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"],
            suggestedFix: `rotate ${API_KEY}`,
          },
        ],
      };
      const run = await runWith(fakeClaude({ lines: [result({ structured_output: leaky })] }));
      expect(run.status).toBe("ok");
      const text = JSON.stringify(run.output);
      for (const leak of [API_KEY, "gate-env-token", "ghp_", "AKIA", "BEGIN PRIVATE KEY"])
        expect(text).not.toContain(leak);
      expect(run.output?.summary).toContain(REDACTED);
    } finally {
      delete process.env.MS_TEST_GATE_TOKEN;
    }
  });

  it("reports failures as error without echoing stderr secrets", async () => {
    const run = await runWith(fakeClaude({ stderr: `warming up\nfatal: auth failed for ${API_KEY}\n`, exitCode: 2 }));
    expect(run.status).toBe("error");
    expect(run.error).toContain("exit code 2");
    expect(run.error).not.toContain(API_KEY);
  });

  it("reports a missing workspace as error", async () => {
    const run = await runWith(fakeClaude({}), { cwd: "/nonexistent-ws" });
    expect(run.status).toBe("error");
    expect(run.error).toContain("workspace directory does not exist");
  });

  it("reports a missing binary as error", async () => {
    const run = await runWith({ binary: "/nonexistent/claude" });
    expect(run.status).toBe("error");
    expect(run.error).toContain("not found");
  });

  it("scrubs the child env, isolates HOME, and injects only the connection's credential", async () => {
    process.env.MS_TEST_SUPER_SECRET = "hunter2-should-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-gate-env-0000000000";
    try {
      const pass = [result({ structured_output: PASS })];
      const apiKeyFake = fakeClaude({ lines: pass });
      await runWith(apiKeyFake);
      const envA = apiKeyFake.record().env;
      expect(envA.MS_TEST_SUPER_SECRET).toBeUndefined();
      expect(envA.ANTHROPIC_API_KEY).toBe(API_KEY);
      expect(envA.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      expect(envA.DISABLE_TELEMETRY).toBe("1");
      expect(envA.PATH).toBeDefined();
      // Non-subscription: an empty temporary HOME, so no host credentials are readable.
      expect(envA.HOME).not.toBe(process.env.HOME);
      expect(envA.HOME).toMatch(/ms-claude-/);
      expect(envA.CLAUDE_CONFIG_DIR?.startsWith(envA.HOME ?? "?")).toBe(true);

      const subFake = fakeClaude({ lines: pass });
      const sub = conn({ kind: "subscription", secret: { kind: "subscription" } });
      const run = await new ClaudeCodeRunner(sub, model({ zeroCost: true }), {}, { binary: subFake.binary }).run(
        seat({}, { maxUsd: 1 }),
        input(),
        ws(workdir()),
      );
      const envS = subFake.record().env;
      expect(envS.ANTHROPIC_API_KEY).toBeUndefined();
      expect(envS.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(envS.MS_TEST_SUPER_SECRET).toBeUndefined();
      // Subscription: the login lives in the user's HOME, so it stays.
      expect(envS.HOME).toBe(process.env.HOME);
      expect(subFake.record().argv).not.toContain("--max-budget-usd");
      expect(run.audit.costUsd).toBe(0);
    } finally {
      delete process.env.MS_TEST_SUPER_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("omits an effort level the model does not support", () => {
    const r = new ClaudeCodeRunner(conn(), model({ effortLevels: ["low", "high"] }), {});
    const withEffort = (e: string) =>
      r.buildArgs(seat({ model: { connectionId: "c", provider: "anthropic", name: "m", effort: e } }), input());
    expect(withEffort("high")).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(withEffort("ludicrous")).not.toContain("--effort");
  });
});

describe("buildCliEnv", () => {
  const base = { PATH: "/bin", HOME: "/home/x", AWS_SECRET_ACCESS_KEY: "nope", ANTHROPIC_API_KEY: "gate-key" };
  it("sets credentials per connection kind", () => {
    expect(buildCliEnv(conn(), { baseEnv: base })).toMatchObject({ PATH: "/bin", ANTHROPIC_API_KEY: API_KEY });
    expect(buildCliEnv(conn(), { baseEnv: base }).HOME).toBeUndefined();
    const compat = buildCliEnv(
      conn({
        kind: "anthropic-compatible",
        secret: {
          kind: "anthropic-compatible",
          baseUrl: "https://gw.example",
          apiKey: "gw-key-123456789",
          headers: { "X-Team": "a" },
        },
      }),
      { baseEnv: base },
    );
    expect(compat).toMatchObject({
      ANTHROPIC_BASE_URL: "https://gw.example",
      ANTHROPIC_API_KEY: "gw-key-123456789",
      ANTHROPIC_CUSTOM_HEADERS: "X-Team: a",
    });
    const bearer = buildCliEnv(
      conn({
        kind: "anthropic-compatible",
        options: { authHeader: "bearer" },
        secret: { kind: "anthropic-compatible", baseUrl: "https://gw", apiKey: "gw-key-123456789" },
      }),
      { baseEnv: base },
    );
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe("gw-key-123456789");
    expect(bearer.ANTHROPIC_API_KEY).toBeUndefined();
    const oauth = buildCliEnv(conn({ kind: "oauth", secret: { kind: "oauth", accessToken: "oauth-token-123456" } }), {
      baseEnv: base,
    });
    expect(oauth.ANTHROPIC_AUTH_TOKEN).toBe("oauth-token-123456");
    expect(oauth.ANTHROPIC_API_KEY).toBeUndefined();
    const sub = buildCliEnv(
      conn({ kind: "subscription", secret: { kind: "subscription", credentialFileRef: "/home/x/.claude-review" } }),
      { baseEnv: base },
    );
    expect(sub.CLAUDE_CONFIG_DIR).toBe("/home/x/.claude-review");
    expect(sub.HOME).toBe("/home/x");
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    for (const e of [compat, oauth, sub]) expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("uses a temp HOME and XDG dirs for non-subscription kinds and prepends the wrapper bin dir", () => {
    const e = buildCliEnv(
      conn(),
      { baseEnv: { ...base, XDG_CONFIG_HOME: "/home/x/.config" } },
      { binDir: "/t/bin", home: "/t/home" },
    );
    expect(e).toMatchObject({
      HOME: "/t/home",
      XDG_CONFIG_HOME: "/t/home/.config",
      CLAUDE_CONFIG_DIR: "/t/home/.claude",
    });
    expect(e.PATH?.startsWith("/t/bin")).toBe(true);
    const s = buildCliEnv(
      conn({ kind: "subscription", secret: { kind: "subscription" } }),
      { baseEnv: base },
      { binDir: "/t/bin", home: "/t/home" },
    );
    expect(s.HOME).toBe("/home/x");
  });

  it("never passes ANTHROPIC_/CLAUDE_ variables through, even when asked", () => {
    const e = buildCliEnv(conn({ kind: "subscription", secret: { kind: "subscription" } }), {
      baseEnv: base,
      envPassthrough: ["ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY"],
    });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.AWS_SECRET_ACCESS_KEY).toBe("nope");
  });
});

describe("cliAllowedTools", () => {
  it("rejects commands that could widen the rule, bare interpreters and raw git", () => {
    const rejected: string[] = [];
    const cmds = [
      "npm test",
      "make lint",
      "a(b)",
      "x, Edit",
      "echo $(id)",
      "node",
      "python3",
      "bash",
      "env",
      "find",
      "xargs",
      "git",
      "git status",
    ];
    const tools = cliAllowedTools(cmds, (c) => rejected.push(c));
    expect(tools).toContain("Bash(npm test:*)");
    expect(tools).toContain("Bash(make lint:*)");
    expect(tools).toContain("Bash(ms-git:*)");
    expect(tools.some((t) => t.startsWith("Bash(git"))).toBe(false);
    expect(rejected).toEqual(cmds.slice(2));
  });
});
