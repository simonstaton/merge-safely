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
import { createReadOnlyTools } from "./executor.js";
import { globToRegExp, matchGlob } from "./glob.js";
import { PathError, resolveSafe } from "./paths.js";
import { scrubbedEnv } from "./proc.js";
import { toolsSystemPromptFragment } from "./prompt.js";
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
  it("matches exactly or as a prefix followed by a space", () => {
    const allowed = ["npm test", "npx vitest run"];
    expect(matchAllowlist("npm test", allowed)).toBe("npm test");
    expect(matchAllowlist("npm test -- --run", allowed)).toBe("npm test");
    expect(matchAllowlist("npm testx", allowed)).toBeUndefined();
    expect(matchAllowlist("npm", allowed)).toBeUndefined();
    expect(matchAllowlist("npx vitest run src", allowed)).toBe("npx vitest run");
    expect(matchAllowlist("anything", ["", "  "])).toBeUndefined();
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

describe("scrubbedEnv", () => {
  it("keeps only the allowlist", () => {
    process.env.MS_SCRUB_SECRET = "x";
    try {
      const env = scrubbedEnv({ EXTRA: "1" });
      expect(env.MS_SCRUB_SECRET).toBeUndefined();
      expect(env.EXTRA).toBe("1");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.MS_SCRUB_SECRET;
    }
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

  it("maps to Gemini declarations, dropping unsupported schema keys", () => {
    const g = toGeminiFunctionDeclarations([submitReviewDefinition(REVIEWER_OUTPUT_JSON_SCHEMA, "hunter")]);
    const json = JSON.stringify(g);
    expect(json).not.toContain("additionalProperties");
    expect(json).not.toContain("$schema");
    expect(g[0]?.parameters).toMatchObject({ type: "object", required: ["verdict", "summary", "findings"] });
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
