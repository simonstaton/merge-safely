import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test/helpers.js";
import { runSuite } from "./runner.js";
import { loadSuite } from "./suite.js";
import { CASE_README, initSuite, scaffoldCase } from "./template.js";

describe("template", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("initialises a suite once", async () => {
    expect(await initSuite(dir, { name: "mine" })).toBe(true);
    expect(await initSuite(dir)).toBe(false);
    expect(await readFile(join(dir, "suite.yml"), "utf8")).toMatch(/name: mine[\s\S]*minRecall: 0.8/);
  });

  it("scaffolds a commented case that loads and dry-runs", async () => {
    await initSuite(dir);
    const r = await scaffoldCase(dir, { id: "prod-incident-42", kind: "incident", title: "Backfill locked orders" });
    expect(r.dir).toBe(join(dir, "prod-incident-42"));
    const yml = await readFile(join(r.dir, "case.yml"), "utf8");
    expect(yml).toContain("# Eval case: Backfill locked orders");
    expect(yml).toContain("decision: block");
    expect(yml).toContain("findingClasses: [replace-me]");
    expect(await readFile(join(r.dir, "README.md"), "utf8")).toBe(CASE_README);
    expect(CASE_README).toMatch(/Remove secrets/);
    expect((await stat(join(r.dir, "base"))).isDirectory()).toBe(true);
    expect((await stat(join(r.dir, "head"))).isDirectory()).toBe(true);

    const suite = await loadSuite(dir);
    expect(suite.cases[0]?.spec).toMatchObject({
      id: "prod-incident-42",
      kind: "incident",
      title: "Backfill locked orders",
    });
    // Empty trees: nothing changed, so the gate refuses to triage it away and a dry run still completes.
    const result = await runSuite(dir, { dry: true });
    expect(result.cases[0]?.actual.status).toBe("dry");
  });

  it("scaffolds clean cases expecting pass without block-only fields", async () => {
    const r = await scaffoldCase(dir, { id: "ok", kind: "clean", title: "Fine" });
    const yml = await readFile(join(r.dir, "case.yml"), "utf8");
    expect(yml).toContain("decision: pass");
    expect(yml).not.toContain("findingClasses");
  });

  it("refuses bad ids and existing cases", async () => {
    await expect(scaffoldCase(dir, { id: "Bad Id", kind: "clean", title: "x" })).rejects.toThrow(/invalid case id/);
    await scaffoldCase(dir, { id: "dup", kind: "clean", title: "x" });
    await expect(scaffoldCase(dir, { id: "dup", kind: "clean", title: "x" })).rejects.toThrow(/already exists/);
  });
});
