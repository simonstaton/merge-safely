import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { diffFromFiles, type FileContents, hunksFor, parseUnifiedDiff } from "./diff.js";
import { sampleFixtures } from "./fixtures.js";
import { fakeWorkspace } from "./workspace.js";

const run = promisify(execFile);

const lines = (n: number, f = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`;

const FILES: FileContents[] = [
  {
    path: "src/a.ts",
    before: lines(20),
    after: lines(20, (i) => (i === 3 || i === 17 ? `changed ${i}` : `line ${i}`)),
  },
  { path: "src/new.ts", after: "export const x = 1;\n" },
  { path: "src/gone.ts", before: "export const y = 2;\nexport const z = 3;\n" },
  { path: "src/eol.ts", before: "a\nb", after: "a\nb\nc" },
  {
    path: "src/moved.ts",
    previousPath: "src/old-name.ts",
    before: lines(5),
    after: lines(5, (i) => (i === 5 ? "five" : `line ${i}`)),
  },
  { path: "src/same.ts", before: "same\n", after: "same\n" },
];

describe("diffFromFiles", () => {
  const { diff, files } = diffFromFiles(FILES);

  it("produces parseable hunks whose counts match their headers", () => {
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.map((f) => f.newPath)).toEqual(["src/a.ts", "src/new.ts", null, "src/eol.ts", "src/moved.ts"]);
    // Two changes 14 lines apart become two hunks with 3 lines of context.
    expect(parsed[0]?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 6, 1, 6],
      [14, 7, 14, 7],
    ]);
    expect(parsed[1]?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(parsed[2]?.oldPath).toBe("src/gone.ts");
  });

  it("fills ChangedFile with status, counts and the hunk-only patch", () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 2],
      ["src/new.ts", "added", 1, 0],
      ["src/gone.ts", "removed", 0, 2],
      ["src/eol.ts", "modified", 2, 1],
      ["src/moved.ts", "renamed", 1, 1],
    ]);
    expect(files[4]?.previousPath).toBe("src/old-name.ts");
    for (const f of files) expect(f.patch?.startsWith("@@ -")).toBe(true);
    expect(files[3]?.patch).toContain("\\ No newline at end of file");
  });

  it("applies cleanly with git apply and reproduces the after contents", async () => {
    const before: Record<string, string> = {};
    for (const f of FILES) if (f.before !== undefined) before[f.previousPath ?? f.path] = f.before;
    const h = await fakeWorkspace({ files: before }).acquire(sampleFixtures.smallLogic.change);
    const patchDir = await mkdtemp(join(tmpdir(), "testkit-patch-"));
    try {
      const patchFile = join(patchDir, "change.patch");
      await writeFile(patchFile, diff);
      await run("git", ["apply", "--check", patchFile], { cwd: h.cwd });
      await run("git", ["apply", patchFile], { cwd: h.cwd });
      for (const f of FILES) {
        if (f.after !== undefined) expect(await readFile(join(h.cwd, f.path), "utf8")).toBe(f.after);
      }
      await expect(readFile(join(h.cwd, "src/gone.ts"), "utf8")).rejects.toThrow();
      await expect(readFile(join(h.cwd, "src/old-name.ts"), "utf8")).rejects.toThrow();
    } finally {
      await h.dispose();
      await rm(patchDir, { recursive: true, force: true });
    }
  });

  it("sample fixture diffs apply to their base contents", async () => {
    for (const f of sampleFixtures.all()) {
      const h = await fakeWorkspace({ files: f.baseFiles }).acquire(f.change);
      const patchDir = await mkdtemp(join(tmpdir(), "testkit-patch-"));
      try {
        const patchFile = join(patchDir, "change.patch");
        await writeFile(patchFile, f.diff);
        await run("git", ["apply", patchFile], { cwd: h.cwd });
        for (const [path, content] of Object.entries(f.headFiles)) {
          expect(await readFile(join(h.cwd, path), "utf8")).toBe(content);
        }
      } finally {
        await h.dispose();
        await rm(patchDir, { recursive: true, force: true });
      }
    }
  });

  it("skips identical files and rejects an entry with no contents", () => {
    expect(hunksFor("x\n", "x\n")).toBe("");
    expect(() => diffFromFiles([{ path: "x" }])).toThrow(/before, after/);
  });
});

describe("parseUnifiedDiff", () => {
  it("rejects a hunk whose header lies about its length", () => {
    const bad = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n";
    expect(() => parseUnifiedDiff(bad)).toThrow(/has 1 old \/ 1 new/);
  });
});

describe("sampleFixtures", () => {
  it.each(sampleFixtures.all().map((f) => [f.name, f] as const))("%s has a valid diff matching its files", (_n, f) => {
    const parsed = parseUnifiedDiff(f.diff);
    expect(parsed.length).toBe(f.change.files.length);
    expect(f.change.stats.files).toBe(f.change.files.length);
    for (const file of f.change.files) {
      expect(file.patch).toBeTruthy();
      expect(f.diff).toContain(file.patch as string);
    }
  });

  it("covers tiers 0, 1 and 3, with the auth fixture on critical paths", () => {
    expect(sampleFixtures.all().map((f) => f.expectedTier)).toEqual([0, 1, 3]);
    const paths = sampleFixtures.authMigration.change.files.map((f) => f.path);
    expect(paths).toContain("src/auth/session.ts");
    expect(paths.some((p) => p.startsWith("migrations/") && p.endsWith(".sql"))).toBe(true);
    expect(sampleFixtures.docsOnly.change.files.every((f) => f.path.endsWith(".md"))).toBe(true);
  });

  it("returns a fresh copy on each access", () => {
    const a = sampleFixtures.smallLogic;
    a.change.title = "mutated";
    expect(sampleFixtures.smallLogic.change.title).not.toBe("mutated");
  });
});
