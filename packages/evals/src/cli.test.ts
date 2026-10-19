import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_CASES, SUITE_YML, tempDir, writeSuite } from "../test/helpers.js";
import { evalCommand } from "./cli.js";
import { scriptedGateFactory } from "./scripted.js";

function io(extra: Partial<Parameters<typeof evalCommand>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), ...extra }, out, err };
}

const STARTER = fileURLToPath(new URL("../suites/starter", import.meta.url));

describe("evalCommand", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("runs the starter suite dry and exits 0", async () => {
    const t = io();
    expect(await evalCommand(["--suite", STARTER, "--dry", "--format", "markdown"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("## Eval suite: starter");
  });

  it("exits 1 when a gate fails and prints breaker suggestions", async () => {
    await writeSuite(dir, SUITE_YML, STANDARD_CASES);
    const { factory } = scriptedGateFactory({
      "incident-auth": { decision: "pass" },
      "clean-docs": { decision: "pass" },
      "clean-code": { decision: "block", findings: [{ class: "logic-error", lens: "correctness" }] },
    });
    const t = io({ gateFactory: factory });
    const out = join(dir, "report.json");
    expect(await evalCommand(["--suite", dir, "--out", out], t.io)).toBe(1);
    const text = t.out.join("");
    expect(text).toContain("FAILED");
    expect(text).toContain("Circuit breakers (suggestions only");
    expect(JSON.parse(await readFile(out, "utf8"))).toHaveProperty("summary.recall", 0);

    const fixed = scriptedGateFactory({
      "incident-auth": {
        decision: "block",
        findings: [{ class: "authn-bypass", lens: "security", file: "src/auth/login.ts" }],
      },
      "clean-docs": { decision: "pass" },
      "clean-code": { decision: "pass" },
    });
    const t2 = io({ gateFactory: fixed.factory });
    expect(await evalCommand(["--suite", dir, "--compare", out], t2.io)).toBe(0);
    expect(t2.out.join("")).toContain("FIXED incident-auth");
  });

  it("returns 2 for usage and validation errors", async () => {
    const t = io();
    expect(await evalCommand([], t.io)).toBe(2);
    expect(await evalCommand(["--suite", dir, "--format", "html"], t.io)).toBe(2);
    expect(await evalCommand(["--suite", STARTER], t.io)).toBe(2);
    expect(t.err.join("")).toMatch(/use --dry/);
    expect(await evalCommand(["--suite", dir, "--dry"], t.io)).toBe(2);
    expect(t.err.join("")).toMatch(/suite.yml not found/);
    expect(await evalCommand(["--suite", STARTER, "--dry", "--kinds", "bogus"], t.io)).toBe(2);
    expect(await evalCommand(["--help"], t.io)).toBe(0);
  });

  it("init creates a suite and a case", async () => {
    const t = io();
    const suite = join(dir, "evals");
    expect(
      await evalCommand(["init", suite, "--case", "inc-1", "--kind", "incident", "--title", "Locked table"], t.io),
    ).toBe(0);
    expect(await readFile(join(suite, "inc-1", "case.yml"), "utf8")).toContain('title: "Locked table"');
    expect(await evalCommand(["init", suite, "--case", "inc-1"], t.io)).toBe(2);
  });
});
