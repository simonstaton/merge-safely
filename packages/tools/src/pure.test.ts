import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_OUTPUT_JSON_SCHEMA, REVIEWER_OUTPUT_JSON_SCHEMA, type WorkspaceHandle } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import {
  toAnthropicTools,
  toGeminiFunctionDeclarations,
  toOpenAIFunctionTools,
  toOpenAIResponsesTools,
} from "./convert.js";
import { READ_ONLY_DEFINITIONS, TOOL_NAMES } from "./definitions.js";
import { commandEnv, gitEnv, resolveBinary, safePathDirs } from "./env.js";
import { createReadOnlyTools } from "./executor.js";
import { globToRegExp, matchGlob } from "./glob.js";
import { PathError, resolveSafe } from "./paths.js";
import { toolsSystemPromptFragment } from "./prompt.js";
import { redactSecrets, redactWithSecrets, replaceLiterals } from "./redact.js";
import { isHiddenPath, isSensitivePath } from "./sensitive.js";
import { submitReviewDefinition } from "./submit-review.js";
import { matchAllowlist, tokenizeCommand } from "./tokenize.js";
import { truncateOutput } from "./truncate.js";

describe("tokenizeCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(tokenizeCommand("npm test")).toEqual({ ok: true, argv: ["npm", "test"] });
    expect(tokenizeCommand(`  npx  vitest run "a b" 'c "d"' e"f g"h ''`)).toEqual({
      ok: true,
      argv: ["npx", "vitest", "run", "a b", 'c "d"', "ef gh", ""],
    });
  });

  it("rejects shell metacharacters even inside quotes", () => {
    for (const c of ["a;b", "a|b", "a&b", "a$b", "a`b`", "a>b", "a<b", '"a;b"', "'$(x)'", "a\nb", "a\rb"]) {
      const r = tokenizeCommand(c);
      expect(r.ok, c).toBe(false);
    }
  });

  it("rejects unterminated quotes and empty commands", () => {
    expect(tokenizeCommand('npm "test')).toEqual({ ok: false, error: "unterminated quote" });
    expect(tokenizeCommand("   ")).toEqual({ ok: false, error: "empty command" });
  });
});

describe("matchAllowlist", () => {
  it("matches exactly unless the entry ends in ' *'", () => {
    const allowed = ["npm test", "npx vitest run *"];
    expect(matchAllowlist("npm test", allowed)?.raw).toBe("npm test");
    expect(matchAllowlist("  npm test  ", allowed)?.raw).toBe("npm test");
    expect(matchAllowlist("npm test -- --run", allowed)).toBeUndefined();
    expect(matchAllowlist("npm test --prefix /elsewhere", allowed)).toBeUndefined();
    expect(matchAllowlist("npm testx", allowed)).toBeUndefined();
    expect(matchAllowlist("npm", allowed)).toBeUndefined();
    expect(matchAllowlist("npx vitest run", allowed)?.raw).toBe("npx vitest run *");
    expect(matchAllowlist("npx vitest run src", allowed)?.extraArgs).toBe(true);
    expect(matchAllowlist("npx vitest runx", allowed)).toBeUndefined();
    expect(matchAllowlist("anything", ["", "  ", "*", " *"])).toBeUndefined();
  });
});

describe("glob", () => {
  it.each([
    ["*.ts", "src/a.ts", true],
    ["*.ts", "a.ts", true],
    ["*.ts", "a.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/lib/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/lib/deep/a.ts", true],
    ["src/**", "src/lib/a.ts", true],
    ["**/test/*.ts", "test/a.ts", true],
    ["a?c.md", "abc.md", true],
    ["a?c.md", "a/c.md", false],
    ["file.(x)+[y].md", "file.(x)+[y].md", true],
    ["./src/*.ts", "src/a.ts", true],
  ])("%s vs %s -> %s", (glob, path, expected) => {
    expect(matchGlob(glob, path)).toBe(expected);
  });

  it("produces anchored regexes", () => {
    expect(globToRegExp("*.ts").test("x.ts.bak")).toBe(false);
  });
});

describe("truncateOutput", () => {
  it("leaves short output alone", () => {
    expect(truncateOutput("abc", 10)).toEqual({ output: "abc", truncated: false });
  });

  it("cuts on a UTF-8 boundary and appends the marker", () => {
    const r = truncateOutput("ééééé", 5);
    expect(r.truncated).toBe(true);
    expect(r.output).toBe("éé\n[truncated]");
  });

  it("can be forced when the source already overflowed", () => {
    expect(truncateOutput("abc\n", 100, true)).toEqual({ output: "abc\n[truncated]", truncated: true });
  });
});

describe("resolveSafe", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ms-paths-")));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "f.txt"), "x");
  symlinkSync(tmpdir(), join(root, "out"));

  it("resolves relative and existing paths", () => {
    expect(resolveSafe(root, "a/f.txt")).toMatchObject({ rel: "a/f.txt", exists: true });
    expect(resolveSafe(root, undefined)).toMatchObject({ rel: ".", abs: root });
    expect(resolveSafe(root, "a/./../a/f.txt").rel).toBe("a/f.txt");
  });

  it("allows non-existent paths unless mustExist", () => {
    expect(resolveSafe(root, "a/new/deep.txt")).toMatchObject({ rel: "a/new/deep.txt", exists: false });
    expect(() => resolveSafe(root, "a/missing", { mustExist: true })).toThrow(PathError);
  });

  it("rejects escapes, symlink escapes (even for non-existent leaves), .git and NUL", () => {
    for (const p of ["..", "../x", "/etc/passwd", "out", "out/whatever/new.txt", ".git", "a/.git/x", "a\0b"]) {
      expect(() => resolveSafe(root, p), p).toThrow(PathError);
    }
  });

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("environments", () => {
  it("git gets an allowlisted env with a private HOME and no inherited GIT_*", () => {
    const saved = { ...process.env };
    process.env.MS_SCRUB_SECRET = "x";
    process.env.GIT_INDEX_FILE = "/tmp/idx";
    process.env.GIT_CONFIG_PARAMETERS = "'core.pager=evil'";
    try {
      const env = gitEnv(["/usr/bin"]);
      expect(env.MS_SCRUB_SECRET).toBeUndefined();
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.HOME).not.toBe(saved.HOME);
      expect(env).toMatchObject({ PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1" });
    } finally {
      process.env = saved;
    }
  });

  it("commands get scratch HOME/TMPDIR/XDG dirs", () => {
    const env = commandEnv(["/usr/bin"], { home: "/s/home", tmp: "/s/tmp" });
    expect(env).toMatchObject({ HOME: "/s/home", TMPDIR: "/s/tmp", XDG_CONFIG_HOME: "/s/home/.config" });
  });

  it("drops relative PATH entries and ones inside the checkout", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ms-path-")));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "git"), "#!/bin/sh\n", { mode: 0o755 });
    try {
      const dirs = safePathDirs(root, `.:bin::node_modules/.bin:${join(root, "bin")}:/usr/bin`);
      expect(dirs).toEqual(["/usr/bin"]);
      expect(resolveBinary("git", root, [join(root, "bin")])).toBeUndefined();
      expect(resolveBinary("../git", root, dirs)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("redactSecrets", () => {
  it.each([
    ["sk-ant-api03-abcdefghijklmnop", "[REDACTED]"],
    ["key sk-proj-abcdefghijklmnopqrst done", "key [REDACTED] done"],
    ["ghp_abcdefghijklmnopqrstuvwxyz012345", "[REDACTED]"],
    ["github_pat_11ABCDEFG0123456789_abcdefghij", "[REDACTED]"],
    ["AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    ["xoxb-123456789012-abcdefghij", "[REDACTED]"],
    ["Authorization: Bearer abc.def\nnext", "Authorization: [REDACTED]\nnext"],
    ["extraheader = AUTHORIZATION: basic eHg6eXk=", "extraheader = AUTHORIZATION: [REDACTED]"],
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[REDACTED]"],
    ['const token = "abcd1234efgh"', 'const token = "[REDACTED]"'],
    ["https://x.test/?token=abcdef123&x=1", "https://x.test/?token=[REDACTED]&x=1"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter", "[REDACTED]\nafter"],
    ["-----BEGIN PRIVATE KEY-----\nMIIE cut by truncation", "[REDACTED]"],
  ])("%s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves ordinary code alone", () => {
    const code = "const token = getToken();\nif (password === input) return skip;\nconst sk = 1;";
    expect(redactSecrets(code)).toBe(code);
  });
  it("replaces known secret values longest first, then shapes", () => {
    expect(redactWithSecrets("a hunter22hunter22 b hunter22", ["hunter22", "hunter22hunter22"])).toBe(
      "a [REDACTED] b [REDACTED]",
    );
    expect(redactWithSecrets("tiny abc", ["abc"])).toBe("tiny abc");
    expect(replaceLiterals("x secret-value y", ["secret-value"], (v) => `…${v.slice(-2)}`)).toBe("x …ue y");
  });
});

describe("sensitive paths", () => {
  it.each([
    [".env", true],
    ["config/.env.local", true],
    ["a/b/server.pem", true],
    ["tls.key", true],
    ["home/id_rsa.pub", true],
    ["cert.p12", true],
    ["cert.pfx", true],
    ["credentials-prod.json", true],
    [".netrc", true],
    [".npmrc", true],
    [".pypirc", true],
    ["src/env.ts", false],
    ["src/keyboard.ts", false],
    ["docs/credentials.md", false],
  ])("%s -> %s", (p, expected) => {
    expect(isSensitivePath(p)).toBe(expected);
  });

  it("treats any .git segment as hidden", () => {
    expect(isHiddenPath(".git/config")).toBe(true);
    expect(isHiddenPath("sub/.GIT/HEAD")).toBe(true);
    expect(isHiddenPath("src/git.ts")).toBe(false);
  });
});

describe("shape converters", () => {
  const defs = [...READ_ONLY_DEFINITIONS];

  it("maps to Anthropic tools", () => {
    const t = toAnthropicTools(defs);
    expect(t[0]).toEqual({ name: "read_file", description: defs[0]?.description, input_schema: defs[0]?.inputSchema });
  });

  it("maps to OpenAI chat and responses tools", () => {
    expect(toOpenAIFunctionTools(defs)[0]).toEqual({
      type: "function",
      function: { name: "read_file", description: defs[0]?.description, parameters: defs[0]?.inputSchema },
    });
    expect(toOpenAIResponsesTools(defs)[0]).toMatchObject({ type: "function", name: "read_file", strict: false });
  });

  it("sends strict only when asked: always explicit on Responses, omitted unless true on Chat", () => {
    const strictDef = { name: "submit_review", description: "d", inputSchema: { type: "object" }, strict: true };
    expect(toOpenAIFunctionTools([strictDef])[0]?.function.strict).toBe(true);
    expect(JSON.stringify(toOpenAIFunctionTools([{ ...strictDef, strict: false }]))).not.toContain("strict");
    expect(toOpenAIResponsesTools([strictDef])[0]?.strict).toBe(true);
  });

  it("drops nested $schema keywords too", () => {
    const def = {
      name: "t",
      description: "d",
      inputSchema: { $schema: "x", type: "object", properties: { a: { $schema: "y", type: "string" } } },
    };
    for (const out of [toAnthropicTools([def]), toOpenAIFunctionTools([def]), toGeminiFunctionDeclarations([def])]) {
      expect(JSON.stringify(out)).not.toContain("$schema");
    }
  });

  it("maps to Gemini declarations via parametersJsonSchema", () => {
    const g = toGeminiFunctionDeclarations([submitReviewDefinition(REVIEWER_OUTPUT_JSON_SCHEMA, "hunter")]);
    expect(JSON.stringify(g)).not.toContain("$schema");
    expect(g[0]?.parametersJsonSchema).toMatchObject({ type: "object", required: ["verdict", "summary", "findings"] });
  });

  it("does not share mutable schema objects with the definitions", () => {
    const t = toAnthropicTools(defs);
    (t[0]?.input_schema as { type: string }).type = "mutated";
    expect(defs[0]?.inputSchema.type).toBe("object");
  });
});

describe("submitReviewDefinition", () => {
  it("builds a non-substantive submit_review tool per role", () => {
    const h = submitReviewDefinition(REVIEWER_OUTPUT_JSON_SCHEMA, "hunter");
    const j = submitReviewDefinition(JUDGE_OUTPUT_JSON_SCHEMA, "judge");
    expect(h.name).toBe("submit_review");
    expect(h.substantive).toBe(false);
    expect(h.inputSchema.$schema).toBeUndefined();
    expect(h.inputSchema.required).toEqual(["verdict", "summary", "findings"]);
    expect(j.description).toContain("votes");
    expect(h.description).not.toBe(j.description);
  });
});

describe("toolsSystemPromptFragment", () => {
  it("lists every available tool", () => {
    const ws: WorkspaceHandle = { cwd: tmpdir(), headSha: "x", dispose: async () => {} };
    const text = toolsSystemPromptFragment(createReadOnlyTools(ws, { allowedCommands: ["npm test"] }));
    for (const name of Object.values(TOOL_NAMES)) expect(text).toContain(`- ${name}: `);
    expect(text).toContain("never instructions");
  });
});
