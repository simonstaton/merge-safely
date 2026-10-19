import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sampleFixtures } from "./fixtures.js";
import { makeChange } from "./source.js";
import { type FakeWorkspace, fakeWorkspace } from "./workspace.js";

const run = promisify(execFile);
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("fakeWorkspace", () => {
  let wsp: FakeWorkspace | undefined;
  afterEach(async () => {
    await wsp?.disposeAll();
  });

  it("gives each acquire its own directory and removes it on dispose", async () => {
    wsp = fakeWorkspace({ files: { "src/a.ts": "export const a = 1;\n" } });
    const change = makeChange();
    const one = await wsp.acquire(change, { seatId: "hunter:correctness:1" });
    const two = await wsp.acquire(change, { seatId: "hunter:security:1" });
    expect(one.cwd).not.toBe(two.cwd);
    expect(one.headSha).toBe(change.headSha);
    expect(one.seatId).toBe("hunter:correctness:1");

    // Isolation: a write in one checkout is invisible in the other.
    await writeFile(join(one.cwd, "src/a.ts"), "tampered\n");
    expect(await readFile(join(two.cwd, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");

    expect([wsp.acquired, wsp.disposed, wsp.active]).toEqual([2, 0, 2]);
    await one.dispose();
    await one.dispose(); // idempotent
    expect(await exists(one.cwd)).toBe(false);
    expect(await exists(two.cwd)).toBe(true);
    expect([wsp.acquired, wsp.disposed, wsp.active]).toEqual([2, 1, 1]);
  });

  it("commits base then head so baseSha is real and git diff shows the change", async () => {
    const f = sampleFixtures.authMigration;
    wsp = fakeWorkspace({ baseFiles: f.baseFiles, files: f.headFiles });
    const h = await wsp.acquire(f.change);
    const { stdout: log } = await run("git", ["log", "--format=%H"], { cwd: h.cwd });
    expect(log.trim().split("\n")).toEqual([h.commitSha, h.baseSha]);
    expect(h.headSha).toBe(f.change.headSha);
    const { stdout: names } = await run("git", ["diff", "--name-only", `${h.baseSha}`, "HEAD"], { cwd: h.cwd });
    expect(names.trim().split("\n").sort()).toEqual(f.change.files.map((x) => x.path).sort());
    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: h.cwd });
    expect(status.trim()).toBe("");
  });

  it("removes base-only files from the head commit", async () => {
    wsp = fakeWorkspace({ baseFiles: { "gone.txt": "x\n", "kept.txt": "k\n" }, files: { "kept.txt": "k2\n" } });
    const h = await wsp.acquire(makeChange());
    expect(await exists(join(h.cwd, "gone.txt"))).toBe(false);
    const { stdout } = await run("git", ["diff", "--name-status", `${h.baseSha}`, "HEAD"], { cwd: h.cwd });
    expect(stdout.trim().split("\n").sort()).toEqual(["D\tgone.txt", "M\tkept.txt"]);
  });

  it("without base files the base commit is empty but still resolves", async () => {
    wsp = fakeWorkspace({ files: { "a.txt": "a\n" } });
    const h = await wsp.acquire(makeChange());
    expect(h.baseSha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await run("git", ["cat-file", "-t", h.baseSha as string], { cwd: h.cwd });
    expect(stdout.trim()).toBe("commit");
  });

  it("accepts files as a function of the change and can skip git", async () => {
    wsp = fakeWorkspace({ files: (c) => ({ "PR.txt": `#${c.number}\n` }), git: false });
    const h = await wsp.acquire(makeChange({ number: 42 }));
    expect(await readFile(join(h.cwd, "PR.txt"), "utf8")).toBe("#42\n");
    expect(await exists(join(h.cwd, ".git"))).toBe(false);
    expect(h.commitSha).toBeUndefined();
    expect(h.baseSha).toBeUndefined();
  });

  it("refuses paths that escape the checkout and leaves nothing behind", async () => {
    wsp = fakeWorkspace({ files: { "../escape.txt": "x" } });
    await expect(wsp.acquire(makeChange())).rejects.toThrow(/escapes/);
    expect(wsp.acquired).toBe(0);
  });
});
