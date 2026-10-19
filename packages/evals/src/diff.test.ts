import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeTree } from "../test/helpers.js";
import { diffTrees, materializeTrees, parseUnifiedDiff } from "./diff.js";

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

describe("git isolation", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};
  const VARS = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_AUTHOR_NAME", "GIT_CONFIG_GLOBAL"];
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    for (const k of VARS) saved[k] = process.env[k];
  });
  afterEach(async () => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  });

  it("ignores GIT_DIR, GIT_INDEX_FILE and GIT_WORK_TREE from the surrounding environment", async () => {
    const victim = join(dir, "victim");
    await writeTree(victim, { "keep.txt": "mine\n" });
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
    const run = (args: string[]) =>
      exec("git", ["-c", "user.name=v", "-c", "user.email=v@v", "-c", "commit.gpgsign=false", ...args], {
        cwd: victim,
        env,
      });
    await run(["init", "-q"]);
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "victim"]);
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    const index = await readFile(join(victim, ".git", "index"));

    process.env.GIT_DIR = join(victim, ".git");
    process.env.GIT_INDEX_FILE = join(victim, ".git", "index");
    process.env.GIT_WORK_TREE = victim;
    process.env.GIT_AUTHOR_NAME = "intruder";
    await writeTree(join(dir, "base"), { "a.ts": "1\n" });
    await writeTree(join(dir, "head"), { "a.ts": "2\n" });
    const d = await diffTrees(join(dir, "base"), join(dir, "head"));
    expect(d.files).toEqual([expect.objectContaining({ path: "a.ts", additions: 1, deletions: 1 })]);

    for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_AUTHOR_NAME"]) delete process.env[k];
    expect((await run(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await readFile(join(victim, ".git", "index"))).toEqual(index);
    expect((await run(["status", "--porcelain"])).stdout).toBe("");
  });
});

describe("symlinks", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("refuses a symlinked tree root", async () => {
    await writeTree(join(dir, "secret"), { "creds.env": "TOP_SECRET=hunter2\n" });
    await mkdir(join(dir, "case", "head"), { recursive: true });
    await symlink(join(dir, "secret"), join(dir, "case", "base"));
    await expect(
      materializeTrees(join(dir, "case", "base"), join(dir, "case", "head"), { confine: join(dir, "case") }),
    ).rejects.toThrow(/base\/ is a symlink/);
  });

  it("refuses links inside a tree that point outside it or at absolute paths", async () => {
    await writeTree(join(dir, "secret"), { "creds.env": "TOP_SECRET=hunter2\n" });
    await writeTree(join(dir, "case", "head"), { "a.ts": "x\n" });
    await mkdir(join(dir, "case", "base"), { recursive: true });
    await symlink("../../secret/creds.env", join(dir, "case", "head", "leak.env"));
    await expect(diffTrees(join(dir, "case", "base"), join(dir, "case", "head"))).rejects.toThrow(
      /head\/leak.env is a symlink whose target resolves outside the tree/,
    );
    await rm(join(dir, "case", "head", "leak.env"));
    await symlink(join(dir, "secret", "creds.env"), join(dir, "case", "head", "abs.env"));
    await expect(diffTrees(join(dir, "case", "base"), join(dir, "case", "head"))).rejects.toThrow(
      /head\/abs.env is a symlink to an absolute path/,
    );
  });

  it("records in-tree relative links verbatim as symlinks", async () => {
    await writeTree(join(dir, "head"), { "src/real.ts": "export const real = 1;\n" });
    await mkdir(join(dir, "base"), { recursive: true });
    await symlink("real.ts", join(dir, "head", "src", "alias.ts"));
    const d = await diffTrees(join(dir, "base"), join(dir, "head"));
    expect(d.diff).toMatch(/diff --git a\/src\/alias.ts b\/src\/alias.ts\nnew file mode 120000/);
    expect(d.diff).toContain("+real.ts");
    expect(d.diff).not.toContain(dir);
  });
});
