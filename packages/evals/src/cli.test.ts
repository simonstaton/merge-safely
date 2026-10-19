import { readFile, writeFile } from "node:fs/promises";
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

  it("parses flags strictly", async () => {
    const t = io();
    expect(await evalCommand(["--suite", STARTER, "--dry", "--kind", "incident"], t.io)).toBe(2);
    expect(t.err.join("")).toMatch(/unknown flag --kind/);
    expect(await evalCommand(["--suite", STARTER, "-d"], t.io)).toBe(2);
    expect(await evalCommand(["--suite", STARTER, "--dry", "--format", "json", "--format", "text"], t.io)).toBe(2);
    // --dry=true is dry (no gate needed); --dry=false is a full run, which needs a gate.
    expect(await evalCommand(["--suite", STARTER, "--dry=true"], io().io)).toBe(0);
    expect(await evalCommand(["--suite", STARTER, "--dry=yes"], io().io)).toBe(0);
    const full = io();
    expect(await evalCommand(["--suite", STARTER, "--dry=false"], full.io)).toBe(2);
    expect(full.err.join("")).toMatch(/use --dry/);
    expect(await evalCommand(["init", dir, "--suite", "x"], io().io)).toBe(2);
  });

  it("validates --compare and --policy before running, and compares in json too", async () => {
    await writeSuite(dir, SUITE_YML, STANDARD_CASES);
    let reviews = 0;
    const { factory } = scriptedGateFactory({});
    const counting: typeof factory = async (policy, ctx) => {
      const g = await factory(policy, ctx);
      return { estimate: g.estimate, reviewChange: (c, i) => (reviews++, g.reviewChange(c, i)) };
    };
    await writeFile(join(dir, "bad.json"), "{}");
    const bad = io({ gateFactory: counting });
    expect(await evalCommand(["--suite", dir, "--compare", join(dir, "bad.json")], bad.io)).toBe(2);
    expect(bad.err.join("")).toMatch(/not a JSON eval report/);
    await writeFile(join(dir, "policy.yml"), "triage: { maxLines: -1 }\n");
    expect(await evalCommand(["--suite", dir, "--policy", join(dir, "policy.yml")], bad.io)).toBe(2);
    expect(bad.err.join("")).toMatch(/not a valid policy/);
    expect(reviews).toBe(0);

    const base = join(dir, "base.json");
    expect(await evalCommand(["--suite", dir, "--dry", "--out", base], io().io)).toBe(0);
    const j = io();
    expect(await evalCommand(["--suite", dir, "--dry", "--format", "json", "--compare", base], j.io)).toBe(0);
    const parsed = JSON.parse(j.out.join("")) as { comparison?: { flips: unknown[] }; breakers?: unknown };
    expect(parsed.comparison?.flips).toEqual([]);
    expect(parsed.breakers).toBeDefined();

    // --policy feeds the run: with a huge triage limit the clean-code case auto-passes and so fails its expectation.
    await writeFile(join(dir, "policy.yml"), "triage: { maxLines: 5000 }\n");
    const p = io();
    expect(
      await evalCommand(["--suite", dir, "--dry", "--policy", join(dir, "policy.yml"), "--compare", base], p.io),
    ).toBe(1);
    expect(p.out.join("")).toContain("REGRESSED clean-code");
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
