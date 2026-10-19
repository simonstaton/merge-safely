import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { splitEvalArgs } from "../src/cli.js";
import { harness, tempDir } from "./helpers.js";

const STARTER = resolve(import.meta.dirname, "../../evals/suites/starter");

describe("eval", () => {
  it("runs the starter suite dry through the CLI and exits 0", async () => {
    const h = harness();
    const r = await h.run("eval", "--suite", STARTER, "--dry");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("passes global options before eval and evals' own flags after it", async () => {
    const h = harness();
    const r = await h.run("--verbose", "eval", "--suite", STARTER, "--dry", "--format", "json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("summary");
    expect(splitEvalArgs(["--home", "/x", "--json", "eval", "--policy", "p.yml"])).toEqual({
      globals: { home: "/x", json: true },
      rest: ["--policy", "p.yml"],
    });
    expect(splitEvalArgs(["run", "--local"])).toBeUndefined();
  });

  it("passes through usage errors (exit 2) and full runs without connections ask for them", async () => {
    const h = harness();
    let r = await h.run("eval", "--suite", STARTER, "--bogus");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown flag --bogus");
    r = await h.run("eval", "--suite", STARTER);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("connections");
  });

  it("eval init scaffolds a suite", async () => {
    const dir = join(tempDir(), "suite");
    const r = await harness().run("eval", "init", dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "suite.yml"))).toBe(true);
  });
});
