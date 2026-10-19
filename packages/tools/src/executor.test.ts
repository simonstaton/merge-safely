import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutor, WorkspaceHandle } from "@merge-safely/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadOnlyTools, type ReadOnlyToolsOptions } from "./executor.js";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
}

let base: string;
let repo: string;
let outside: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ms-tools-")));
  repo = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");

  sh(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), 'import { add } from "./lib/math.js";\nexport const x = add(1, 2);\n');
  writeFileSync(
    join(repo, "src", "lib", "math.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  );
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "initial");
  baseSha = sh(repo, "rev-parse", "HEAD").trim();

  writeFileSync(
    join(repo, "src", "lib", "math.ts"),
    "export function add(a: number, b: number) {\n  return a - b; // bug\n}\n\nexport const ADD_NAME = 'add';\n",
  );
  writeFileSync(join(repo, "big.txt"), `${Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  writeFileSync(join(repo, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  writeFileSync(join(repo, "redos.txt"), `${"a".repeat(40)}!\n`);
  writeFileSync(join(repo, "-dash.txt"), "dash\n");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  symlinkSync(outside, join(repo, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(repo, "escape-file.txt"));
  symlinkSync("src/index.ts", join(repo, "inside-link.ts"));
  // Adversarial: force-tracked files that are then ignored, plus rg-specific ignore files, must not hide code.
  writeFileSync(join(repo, "hidden.ts"), "export const sneaky = add(4, 5);\n");
  symlinkSync(join(outside, "secret.txt"), join(repo, "hidden-link.txt"));
  writeFileSync(join(repo, ".rgignore"), "src/\n");
  writeFileSync(join(repo, ".ignore"), "src/\n");
  sh(repo, "add", "-A");
  sh(repo, "add", "-f", "hidden.ts", "hidden-link.txt");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules\nhidden.ts\nhidden-link.txt\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "second: break add");
  headSha = sh(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "ignored.log"), "add should be ignored\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function tools(opts: ReadOnlyToolsOptions = {}): ToolExecutor {
  const ws: WorkspaceHandle = { cwd: repo, headSha, baseSha, dispose: async () => {} };
  return createReadOnlyTools(ws, opts);
}

describe("definitions", () => {
  it("exposes the read-only set and hides run_command unless allowlisted", () => {
    const names = tools()
      .definitions()
      .map((d) => d.name);
    expect(names).toEqual(["read_file", "list_dir", "find_files", "search", "git_diff", "git_log", "git_blame"]);
    expect(
      tools({ allowedCommands: ["npm test"] })
        .definitions()
        .map((d) => d.name),
    ).toContain("run_command");
    for (const d of tools().definitions()) {
      expect(d.inputSchema.type).toBe("object");
      expect(d.description.length).toBeGreaterThan(20);
    }
  });
});

describe("read_file", () => {
  it("returns numbered lines and records the file", async () => {
    const t = tools();
    const r = await t.execute({ name: "read_file", input: { path: "src/lib/math.ts" } });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("     2\t  return a - b; // bug");
    expect(r.filesRead).toEqual(["src/lib/math.ts"]);
    expect(t.audit().filesRead).toEqual(["src/lib/math.ts"]);
  });

  it("pages with offset/limit and defaults to 400 lines", async () => {
    const t = tools();
    const d = await t.execute({ name: "read_file", input: { path: "big.txt" } });
    expect(d.output).toContain("   400\tline 400");
    expect(d.output).not.toContain("line 401");
    expect(d.output).toContain("offset=401");
    const p = await t.execute({ name: "read_file", input: { path: "big.txt", offset: 998, limit: 10 } });
    expect(p.output.split("\n")).toEqual(["   998\tline 998", "   999\tline 999", "  1000\tline 1000"]);
  });

  it("refuses binary files", async () => {
    const r = await tools().execute({ name: "read_file", input: { path: "image.bin" } });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/^error: .*binary/);
  });

  it("blocks traversal, absolute paths outside, symlink escapes and .git", async () => {
    const t = tools();
    for (const path of [
      "../outside/secret.txt",
      "src/../../outside/secret.txt",
      join(outside, "secret.txt"),
      "escape/secret.txt",
      "escape-file.txt",
      ".git/config",
      "src/../.git/HEAD",
      ".GIT/config",
    ]) {
      const r = await t.execute({ name: "read_file", input: { path } });
      expect(r.ok, path).toBe(false);
      expect(r.output, path).toMatch(/^error: /);
      expect(r.output, path).not.toContain("TOP SECRET");
    }
    expect(t.audit().filesRead).toEqual([]);
    expect(t.audit().substantiveCalls).toBe(0);
  });

  it("follows symlinks that stay inside the workspace", async () => {
    const r = await tools().execute({ name: "read_file", input: { path: "inside-link.ts" } });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("import { add }");
  });

  it("accepts an absolute path inside the workspace", async () => {
    const r = await tools().execute({ name: "read_file", input: { path: join(repo, "README.md") } });
    expect(r.ok).toBe(true);
    expect(r.filesRead).toEqual(["README.md"]);
  });

  it("validates input types", async () => {
    const t = tools();
    expect((await t.execute({ name: "read_file", input: {} })).output).toBe("error: path is required");
    expect((await t.execute({ name: "read_file", input: { path: 3 } })).output).toBe("error: path must be a string");
    expect((await t.execute({ name: "read_file", input: { path: "big.txt", offset: "x" } })).ok).toBe(false);
    expect((await t.execute({ name: "read_file", input: { path: "src" } })).output).toContain("is a directory");
  });
});

describe("list_dir", () => {
  it("lists a tree, skipping node_modules and .git, without following symlinks", async () => {
    const r = await tools().execute({ name: "list_dir", input: {} });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("  src/");
    expect(r.output).toContain("    lib/");
    expect(r.output).toContain("  node_modules/ (skipped)");
    expect(r.output).toContain("  .git/ (skipped)");
    expect(r.output).toContain("  escape@ (symlink)");
    expect(r.output).not.toContain("secret.txt");
    expect(r.output).not.toContain("math.ts");
    const deep = await tools().execute({ name: "list_dir", input: { path: "src", depth: 3 } });
    expect(deep.output).toContain("math.ts");
  });

  it("is not substantive", async () => {
    const t = tools();
    await t.execute({ name: "list_dir", input: {} });
    expect(t.audit()).toMatchObject({ substantiveCalls: 0, totalCalls: 1 });
  });

  it("refuses to list through an escaping symlink", async () => {
    const r = await tools().execute({ name: "list_dir", input: { path: "escape" } });
    expect(r.ok).toBe(false);
  });
});

describe("find_files", () => {
  it("matches globs and respects .gitignore", async () => {
    const t = tools();
    const r = await t.execute({ name: "find_files", input: { glob: "*.ts" } });
    expect(r.output.split("\n")).toEqual(["hidden.ts", "inside-link.ts", "src/index.ts", "src/lib/math.ts"]);
    const r2 = await t.execute({ name: "find_files", input: { glob: "src/**/*.ts" } });
    expect(r2.output.split("\n")).toEqual(["src/index.ts", "src/lib/math.ts"]);
    const r3 = await t.execute({ name: "find_files", input: { glob: "*.log" } });
    expect(r3.output).toBe("no files match *.log");
    const r4 = await t.execute({ name: "find_files", input: { glob: "*", maxResults: 2 } });
    expect(r4.output).toContain("[more than 2 matches");
    const r5 = await t.execute({ name: "find_files", input: { glob: "**/index.js" } });
    expect(r5.output).toBe("no files match **/index.js");
    expect(t.audit().substantiveCalls).toBe(5);
  });
});

function hasRg(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const engines: Array<"js" | "rg"> = hasRg() ? ["js", "rg"] : ["js"];

describe.each(engines)("search (%s)", (engine) => {
  const t = () => tools({ searchEngine: engine });

  it("returns path:line: text and respects .gitignore", async () => {
    const r = await t().execute({ name: "search", input: { pattern: "add\\(" } });
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n").sort();
    expect(lines).toContain("src/index.ts:2: export const x = add(1, 2);");
    expect(lines).toContain("src/lib/math.ts:1: export function add(a: number, b: number) {");
    expect(r.output).not.toContain("ignored.log");
    expect(r.output).not.toContain("TOP SECRET");
  });

  it("cannot be blinded by ignoring tracked files or by .ignore/.rgignore", async () => {
    const r = await t().execute({ name: "search", input: { pattern: "add\\(" } });
    expect(r.output).toContain("hidden.ts:1: export const sneaky = add(4, 5);");
    expect(r.output).toContain("src/lib/math.ts:1:");
    const r2 = await t().execute({ name: "search", input: { pattern: "SECRET" } });
    expect(r2.output).toBe("no matches");
  });

  it("supports path, glob, ignoreCase, literal and maxResults", async () => {
    const x = t();
    expect((await x.execute({ name: "search", input: { pattern: "add", path: "src/lib" } })).output).not.toContain(
      "src/index.ts",
    );
    expect((await x.execute({ name: "search", input: { pattern: "add", glob: "index.ts" } })).output).not.toContain(
      "math.ts",
    );
    const ci = await x.execute({ name: "search", input: { pattern: "demo", ignoreCase: true } });
    expect(ci.output).toBe("README.md:1: # Demo");
    const lit = await x.execute({ name: "search", input: { pattern: "a + b", literal: true } });
    expect(lit.output).toBe("no matches");
    const lit2 = await x.execute({ name: "search", input: { pattern: "a - b", literal: true } });
    expect(lit2.output).toContain("src/lib/math.ts:2:");
    const capped = await x.execute({ name: "search", input: { pattern: "line", path: "big.txt", maxResults: 3 } });
    expect(capped.output.split("\n")).toHaveLength(4);
    expect(capped.output).toContain("more matches not shown");
  });

  it("does not leak files through symlinks or escaping paths", async () => {
    const r = await t().execute({ name: "search", input: { pattern: "SECRET" } });
    expect(r.output).toBe("no matches");
    const r2 = await t().execute({ name: "search", input: { pattern: "SECRET", path: "escape" } });
    expect(r2.ok).toBe(false);
  });

  it("treats a pattern starting with - as a pattern, not an option", async () => {
    const r = await t().execute({ name: "search", input: { pattern: "--files" } });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("no matches");
  });
});

describe("search (js) safety", () => {
  it("kills a catastrophic regex instead of hanging", async () => {
    const t = tools({ searchEngine: "js", searchTimeoutMs: 500 });
    const started = Date.now();
    const r = await t.execute({ name: "search", input: { pattern: "^(a+)+$", path: "redos.txt" } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
  });

  it("reports invalid regex", async () => {
    const r = await tools({ searchEngine: "js" }).execute({ name: "search", input: { pattern: "(" } });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("invalid regular expression");
  });
});

describe("git tools", () => {
  it("git_diff defaults to the change under review", async () => {
    const r = await tools().execute({ name: "git_diff", input: {} });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("-  return a + b;");
    expect(r.output).toContain("+  return a - b; // bug");
  });

  it("git_diff accepts base, head and path", async () => {
    const r = await tools().execute({
      name: "git_diff",
      input: { base: baseSha, head: headSha, path: "README.md" },
    });
    expect(r.output).toBe("no differences");
    const r2 = await tools().execute({ name: "git_diff", input: { base: "HEAD~1", head: "HEAD", path: "src" } });
    expect(r2.output).toContain("math.ts");
  });

  it("git_log lists commits, optionally by path", async () => {
    const r = await tools().execute({ name: "git_log", input: {} });
    expect(r.output).toContain("second: break add");
    expect(r.output).toContain("initial");
    const r2 = await tools().execute({ name: "git_log", input: { path: "README.md", maxCount: 5 } });
    expect(r2.output).not.toContain("second");
  });

  it("git_blame shows line ranges and records the file", async () => {
    const t = tools();
    const r = await t.execute({ name: "git_blame", input: { path: "src/lib/math.ts", startLine: 2, endLine: 2 } });
    expect(r.ok).toBe(true);
    expect(r.output.trim().split("\n")).toHaveLength(1);
    expect(r.output).toContain("return a - b");
    expect(t.audit().filesRead).toEqual(["src/lib/math.ts"]);
  });

  it("rejects option injection in every argument", async () => {
    const t = tools();
    const attempts = [
      { name: "git_diff", input: { base: "--output=/tmp/pwned" } },
      { name: "git_diff", input: { head: "-p" } },
      { name: "git_diff", input: { base: "HEAD", head: "HEAD;rm" } },
      { name: "git_diff", input: { path: "-dash.txt" } },
      { name: "git_log", input: { path: "--all" } },
      { name: "git_blame", input: { path: "-dash.txt" } },
      { name: "git_diff", input: { path: "../outside" } },
      { name: "git_blame", input: { path: ".git/config" } },
      // Paths posing as revisions would put git diff into --no-index mode.
      { name: "git_diff", input: { base: "../outside/secret.txt", head: "README.md" } },
      { name: "git_diff", input: { base: "README.md", head: "escape/secret.txt" } },
      { name: "git_diff", input: { base: "HEAD", head: "../outside/secret.txt" } },
    ];
    for (const call of attempts) {
      const r = await t.execute(call);
      expect(r.ok, JSON.stringify(call)).toBe(false);
      expect(r.output).toMatch(/^error: /);
      expect(r.output).not.toContain("TOP SECRET");
    }
    expect(t.audit().substantiveCalls).toBe(0);
  });
});

describe("run_command", () => {
  it("is rejected when no commands are allowlisted", async () => {
    const r = await tools().execute({ name: "run_command", input: { command: "node -v" } });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("unknown tool");
  });

  it("enforces the allowlist by exact match or prefix + space", async () => {
    const t = tools({ allowedCommands: ["node -v", "git status"] });
    expect((await t.execute({ name: "run_command", input: { command: "node -v" } })).ok).toBe(true);
    expect((await t.execute({ name: "run_command", input: { command: "node -version" } })).output).toContain(
      "not allowlisted",
    );
    expect((await t.execute({ name: "run_command", input: { command: "node -e 1" } })).output).toContain(
      "not allowlisted",
    );
    expect((await t.execute({ name: "run_command", input: { command: "git status --short" } })).ok).toBe(true);
    expect(t.audit().commandsRun).toEqual(["node -v", "git status --short"]);
    expect(t.audit().substantiveCalls).toBe(2);
  });

  it("rejects shell metacharacters", async () => {
    const t = tools({ allowedCommands: ["node"] });
    for (const command of [
      "node -v; cat /etc/passwd",
      "node -v | cat",
      "node -v && id",
      "node -v & id",
      "node $HOME",
      "node `id`",
      "node -v > out.txt",
      "node < in.txt",
      'node "-v; id"',
      "node -v\nid",
    ]) {
      const r = await t.execute({ name: "run_command", input: { command } });
      expect(r.ok, command).toBe(false);
      expect(r.output, command).toMatch(/^error: shell metacharacter/);
    }
    expect(t.audit().commandsRun).toEqual([]);
  });

  it("runs without a shell in ws.cwd with a scrubbed environment", async () => {
    process.env.MS_TEST_SECRET = "sk-live-should-not-leak";
    try {
      const t = tools({ allowedCommands: ["node -e"] });
      const command = 'node -e "console.log(JSON.stringify({cwd: process.cwd(), env: process.env}))"';
      const r = await t.execute({ name: "run_command", input: { command } });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("exit code: 0");
      expect(r.output).not.toContain("sk-live-should-not-leak");
      const json = JSON.parse(r.output.split("\n").slice(2).join("\n")) as { cwd: string; env: Record<string, string> };
      expect(json.cwd).toBe(repo);
      expect(json.env.MS_TEST_SECRET).toBeUndefined();
      expect(json.env.PATH).toBeDefined();
      for (const k of Object.keys(json.env)) expect(["PATH", "HOME", "LANG", "CI", "NODE_ENV"]).toContain(k);
      expect(r.commandRun).toBe(command);
    } finally {
      delete process.env.MS_TEST_SECRET;
    }
  });

  it("reports non-zero exit codes", async () => {
    const r = await tools({ allowedCommands: ["node -e"] }).execute({
      name: "run_command",
      input: { command: 'node -e "process.exit(3)"' },
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("exit code: 3");
  });

  it("kills the whole process group on timeout", async () => {
    const t = tools({ allowedCommands: ["node -e"], commandTimeoutMs: 300 });
    const started = Date.now();
    const r = await t.execute({
      name: "run_command",
      input: {
        command:
          "node -e \"require('node:child_process').spawn('sleep', ['30'], {stdio: 'inherit'}), setInterval(Boolean, 1000)\"",
      },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
    expect(t.audit().commandsRun).toHaveLength(1);
    expect(t.audit().substantiveCalls).toBe(0);
  });

  it("honours an abort signal", async () => {
    const t = tools({ allowedCommands: ["node -e"] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const r = await t.execute(
      { name: "run_command", input: { command: 'node -e "setInterval(Boolean, 1000)"' } },
      ac.signal,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.output).toBe("error: aborted");
  });
});

describe("truncation", () => {
  it("cuts output to maxOutputBytes with a marker", async () => {
    const r = await tools({ maxOutputBytes: 200 }).execute({ name: "read_file", input: { path: "big.txt" } });
    expect(r.truncated).toBe(true);
    expect(r.output.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(200 + "\n[truncated]".length);
  });

  it("truncates command output", async () => {
    const r = await tools({ maxOutputBytes: 1000, allowedCommands: ["node -e"] }).execute({
      name: "run_command",
      input: { command: "node -e \"process.stdout.write('x'.repeat(100000))\"" },
    });
    expect(r.truncated).toBe(true);
    expect(r.output.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(1000 + "\n[truncated]".length);
  });
});

describe("audit and error handling", () => {
  it("counts total and substantive calls and unique files", async () => {
    const t = tools();
    await t.execute({ name: "read_file", input: { path: "README.md" } });
    await t.execute({ name: "read_file", input: { path: "./README.md" } });
    await t.execute({ name: "list_dir", input: {} });
    await t.execute({ name: "search", input: { pattern: "add" } });
    await t.execute({ name: "read_file", input: { path: "missing.ts" } });
    await t.execute({ name: "nope", input: {} });
    expect(t.audit()).toEqual({ substantiveCalls: 3, totalCalls: 6, filesRead: ["README.md"], commandsRun: [] });
  });

  it("returns copies so callers cannot mutate the audit", async () => {
    const t = tools();
    await t.execute({ name: "read_file", input: { path: "README.md" } });
    t.audit().filesRead.push("forged.ts");
    expect(t.audit().filesRead).toEqual(["README.md"]);
  });

  it("never throws, even on malformed calls or a missing workspace", async () => {
    const t = tools();
    const r = await t.execute({ name: "read_file", input: null as unknown as Record<string, unknown> });
    expect(r.ok).toBe(false);
    const gone = createReadOnlyTools({ cwd: join(base, "nope"), headSha: "x", dispose: async () => {} });
    const r2 = await gone.execute({ name: "read_file", input: { path: "a" } });
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain("workspace root is not accessible");
  });

  it("refuses work when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await tools().execute({ name: "read_file", input: { path: "README.md" } }, ac.signal);
    expect(r.ok).toBe(false);
  });
});
