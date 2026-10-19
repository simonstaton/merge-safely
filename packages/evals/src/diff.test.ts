import { execFile } from "node:child_process";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeTree } from "../test/helpers.js";
import { diffTrees, parseUnifiedDiff } from "./diff.js";

const exec = promisify(execFile);

describe("diffTrees", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  const base = {
    "src/keep.ts": "export const keep = 1;\n",
    "src/edit.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    "src/gone.ts": "export const gone = true;\n",
    "src/old/name.ts":
      "export const moved = 'a fairly long line so rename detection has content';\nexport const two = 2;\n",
    "base/.gitkeep": "",
  };
  const head = {
    "src/keep.ts": "export const keep = 1;\n",
    "src/edit.ts": "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n",
    "src/new.ts": "export const fresh = true;\n",
    "src/new/name.ts":
      "export const moved = 'a fairly long line so rename detection has content';\nexport const two = 2;\n",
    "docs/a b.md": "spaces in path\n",
  };

  it("lists every change with correct status and counts", async () => {
    await writeTree(join(dir, "base"), base);
    await writeTree(join(dir, "head"), head);
    const d = await diffTrees(join(dir, "base"), join(dir, "head"));
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      "docs/a b.md",
      "src/edit.ts",
      "src/gone.ts",
      "src/new.ts",
      "src/new/name.ts",
    ]);
    expect(byPath["src/edit.ts"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(byPath["src/gone.ts"]).toMatchObject({ status: "removed", additions: 0, deletions: 1 });
    expect(byPath["src/new.ts"]).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(byPath["src/new/name.ts"]).toMatchObject({ status: "renamed", previousPath: "src/old/name.ts" });
    expect(byPath["docs/a b.md"]).toMatchObject({ status: "added", additions: 1 });
    expect(byPath["src/edit.ts"]?.patch?.startsWith("@@")).toBe(true);
    expect(d.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(d.headSha).not.toBe(d.baseSha);
  });

  it("is deterministic for the same trees", async () => {
    await writeTree(join(dir, "base"), base);
    await writeTree(join(dir, "head"), head);
    const a = await diffTrees(join(dir, "base"), join(dir, "head"));
    const b = await diffTrees(join(dir, "base"), join(dir, "head"));
    expect(b.headSha).toBe(a.headSha);
    expect(b.diff).toBe(a.diff);
  });

  it("produces a diff that applies cleanly to base with git apply", async () => {
    await writeTree(join(dir, "base"), base);
    await writeTree(join(dir, "head"), head);
    const d = await diffTrees(join(dir, "base"), join(dir, "head"));
    const repo = join(dir, "repo");
    await cp(join(dir, "base"), repo, { recursive: true });
    await exec("git", ["init", "-q"], { cwd: repo });
    const patch = join(dir, "change.diff");
    await writeFile(patch, d.diff);
    await exec("git", ["apply", "--check", patch], { cwd: repo });
    await exec("git", ["apply", patch], { cwd: repo });
    for (const [rel, content] of Object.entries(head)) {
      expect(await readFile(join(repo, rel), "utf8")).toBe(content);
    }
    await expect(stat(join(repo, "src/gone.ts"))).rejects.toThrow();
    await expect(stat(join(repo, "src/old/name.ts"))).rejects.toThrow();
  });

  it("treats a missing base as an empty tree", async () => {
    await writeTree(join(dir, "head"), { "a.ts": "x\n" });
    const d = await diffTrees(join(dir, "nope"), join(dir, "head"));
    expect(d.files).toEqual([expect.objectContaining({ path: "a.ts", status: "added", additions: 1 })]);
  });
});

describe("parseUnifiedDiff", () => {
  it("counts SQL comment lines inside hunks as content, not headers", () => {
    const diff = [
      "diff --git a/db/x.sql b/db/x.sql",
      "index 1..2 100644",
      "--- a/db/x.sql",
      "+++ b/db/x.sql",
      "@@ -1,2 +1,2 @@",
      "--- old comment",
      "+-- new comment",
      " SELECT 1;",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]).toMatchObject({ path: "db/x.sql", additions: 1, deletions: 1 });
    expect(files[0]?.patch).toBe("@@ -1,2 +1,2 @@\n--- old comment\n+-- new comment\n SELECT 1;");
    expect(files[1]).toEqual({ path: "img.png", status: "modified", additions: 0, deletions: 0 });
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
