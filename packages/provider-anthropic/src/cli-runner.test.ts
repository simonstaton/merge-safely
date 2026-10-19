import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../test/fake-claude.js";
import { API_KEY, conn, input, model, seat, ws } from "../test/helpers.js";
import { buildCliEnv, ClaudeCodeRunner, cliAllowedTools } from "./cli-runner.js";

const fixture = (n: string) => fileURLToPath(new URL(`../test/fixtures/${n}`, import.meta.url));
const workdir = () => mkdtempSync(join(tmpdir(), "ms-ws-"));

const assistant = (id: string, blocks: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    message: { id, role: "assistant", content: blocks, usage: { input_tokens: 5, output_tokens: 5 } },
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

describe("ClaudeCodeRunner", () => {
  it("passes with tool uses from a real transcript, with read-only flags", async () => {
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
    expect(a).toContain("--strict-mcp-config");
    expect(flag("--disallowedTools")).toContain("Edit");
    expect(flag("--disallowedTools")).toContain("WebFetch");
    expect(flag("--allowedTools")).toBe(
      "Read,Grep,Glob,LS,Bash(git diff:*),Bash(git log:*),Bash(git blame:*),Bash(git show:*),Bash(npm test:*)",
    );
    expect(JSON.parse(flag("--json-schema") ?? "{}").required).toEqual(["verdict", "summary", "findings"]);
    expect(flag("--append-system-prompt")).toContain("You are the correctness lens.");
    expect(a).not.toContain("--max-budget-usd");
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
        assistant("m2", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git diff HEAD~1" } }]),
        result({ structured_output: block, result: JSON.stringify(block) }),
      ],
    });
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(seat(), input(), ws(cwd));
    expect(run.status).toBe("ok");
    expect(run.output?.verdict).toBe("block");
    expect(run.output?.findings[0]).toMatchObject({ severity: "blocker", class: "n-plus-one" });
    expect(run.audit).toMatchObject({
      filesRead: ["src/a.ts"],
      commandsRun: ["git diff HEAD~1"],
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
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(
      seat({}, { maxTurns: 1 }),
      input(),
      ws(cwd),
    );
    expect(run.status).toBe("budget-exceeded");
    expect(run.audit.filesRead).toEqual(["a.txt"]);
    expect(run.error).toContain("raise the seat's maxTurns");
    expect(run.output).toBeNull();
    expect(run.audit.commandsRun).toEqual(["git log"]);
  });

  it("classifies the CLI's own USD budget stop and passes --max-budget-usd", async () => {
    const fake = fakeClaude({
      lines: [result({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.51 })],
      exitCode: 1,
    });
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(
      seat({}, { maxUsd: 0.5 }),
      input(),
      ws(workdir()),
    );
    expect(run.status).toBe("budget-exceeded");
    expect(run.error).toContain("USD");
    const a = fake.record().argv;
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  it("is schema-invalid when the result is not valid JSON", async () => {
    const fake = fakeClaude({ lines: [result({ result: "Looks good to me!" })] });
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(
      seat(),
      input(),
      ws(workdir()),
    );
    expect(run.status).toBe("schema-invalid");
    expect(run.output).toBeNull();

    const wrong = fakeClaude({ lines: [result({ result: '{"verdict":"maybe"}' })] });
    const run2 = await new ClaudeCodeRunner(conn(), model(), {}, { binary: wrong.binary }).run(
      seat(),
      input(),
      ws(workdir()),
    );
    expect(run2.status).toBe("schema-invalid");
    expect(run2.error).toContain("verdict");
  });

  it("kills on deadline (SIGTERM then SIGKILL) and reports timeout with streamed usage", async () => {
    const fake = fakeClaude({
      lines: [assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } }])],
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

  it("reports other failures as error with the scrubbed last stderr line", async () => {
    const fake = fakeClaude({ stderr: `warming up\nfatal: auth failed for ${API_KEY}\n`, exitCode: 2 });
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(
      seat(),
      input(),
      ws(workdir()),
    );
    expect(run.status).toBe("error");
    expect(run.error).toContain("fatal: auth failed");
    expect(run.error).not.toContain(API_KEY);
  });

  it("reports a missing workspace as error", async () => {
    const fake = fakeClaude({});
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: fake.binary }).run(
      seat(),
      input(),
      ws("/nonexistent-ws"),
    );
    expect(run.status).toBe("error");
    expect(run.error).toContain("workspace directory does not exist");
  });

  it("reports a missing binary as error", async () => {
    const run = await new ClaudeCodeRunner(conn(), model(), {}, { binary: "/nonexistent/claude" }).run(
      seat(),
      input(),
      ws(workdir()),
    );
    expect(run.status).toBe("error");
    expect(run.error).toContain("not found");
  });

  it("scrubs the child env and injects only the connection's credential", async () => {
    process.env.MS_TEST_SUPER_SECRET = "hunter2-should-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-gate-env-0000000000";
    try {
      const pass = [result({ structured_output: { verdict: "pass", summary: "ok", findings: [] } })];
      const apiKeyFake = fakeClaude({ lines: pass });
      await new ClaudeCodeRunner(conn(), model(), {}, { binary: apiKeyFake.binary }).run(
        seat(),
        input(),
        ws(workdir()),
      );
      const envA = apiKeyFake.record().env;
      expect(envA.MS_TEST_SUPER_SECRET).toBeUndefined();
      expect(envA.ANTHROPIC_API_KEY).toBe(API_KEY);
      expect(envA.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      expect(envA.DISABLE_TELEMETRY).toBe("1");
      expect(envA.PATH).toBeDefined();

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
      expect(subFake.record().argv).not.toContain("--max-budget-usd");
      expect(run.audit.costUsd).toBe(0);
    } finally {
      delete process.env.MS_TEST_SUPER_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("buildCliEnv", () => {
  const base = { PATH: "/bin", HOME: "/home/x", AWS_SECRET_ACCESS_KEY: "nope", ANTHROPIC_API_KEY: "gate-key" };
  it("sets credentials per connection kind", () => {
    expect(buildCliEnv(conn(), { baseEnv: base })).toMatchObject({
      PATH: "/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: API_KEY,
    });
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
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    for (const e of [compat, oauth, sub]) expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
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
  it("rejects commands that could widen the rule", () => {
    const rejected: string[] = [];
    const tools = cliAllowedTools(["npm test", "make lint", "a(b)", "x, Edit", "echo $(id)"], (c) => rejected.push(c));
    expect(tools).toContain("Bash(npm test:*)");
    expect(tools).toContain("Bash(make lint:*)");
    expect(rejected).toEqual(["a(b)", "x, Edit", "echo $(id)"]);
  });
});
