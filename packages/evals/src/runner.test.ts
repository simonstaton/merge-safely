import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_CASES, SUITE_YML, tempDir, writeSuite, writeTree } from "../test/helpers.js";
import { type EvalGate, estimateWithStages, type GateFactory } from "./gate.js";
import { evaluateCase, runSuite } from "./runner.js";
import { type CaseScript, scriptedGateFactory } from "./scripted.js";
import { parseCase } from "./suite.js";

const GOOD: Record<string, CaseScript> = {
  "incident-auth": {
    decision: "block",
    findings: [{ class: "authn-bypass", lens: "security", file: "src/auth/login.ts", line: 1 }],
    costUsd: 1.5,
    models: { security: "model-a" },
  },
  "clean-docs": { decision: "pass" },
  "clean-code": { decision: "pass", costUsd: 0.25 },
};

describe("runSuite with a scripted gate", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    await writeSuite(dir, SUITE_YML, STANDARD_CASES);
  });
  afterEach(() => cleanup());

  it("passes cases whose verdict matches and records tier, seats, findings and cost", async () => {
    const { factory, calls } = scriptedGateFactory(GOOD);
    const seen: string[] = [];
    const r = await runSuite(dir, { gateFactory: factory, onCase: (c) => seen.push(c.id) });
    expect(r.cases.map((c) => [c.id, c.passed])).toEqual([
      ["clean-code", true],
      ["clean-docs", true],
      ["incident-auth", true],
    ]);
    expect(seen.sort()).toEqual(["clean-code", "clean-docs", "incident-auth"]);
    const inc = r.cases.find((c) => c.id === "incident-auth");
    expect(inc?.actual).toMatchObject({
      decision: "block",
      tier: 3,
      triage: "review",
      status: "ok",
      cost: { usd: 1.5 },
    });
    expect(inc?.actual.findings[0]).toMatchObject({ class: "authn-bypass", lens: "security", models: ["model-a"] });
    expect(inc?.reasons.join(" ")).toMatch(/raised authn-bypass at src\/auth\/login.ts via security/);
    expect(r.cases.find((c) => c.id === "clean-docs")?.actual).toMatchObject({ triage: "auto-pass", seats: 0 });
    expect(r.summary).toMatchObject({ recall: 1, falseBlockRate: 0, ok: true, tierAccuracy: 1 });
    expect(calls.estimate.sort()).toEqual(calls.review.sort());
    expect(calls.factory).toHaveLength(3);
  });

  it("fails cases with populated reasons", async () => {
    const { factory } = scriptedGateFactory({
      "incident-auth": { decision: "block", findings: [{ class: "style", lens: "intent", file: "src/x.ts" }] },
      "clean-docs": { decision: "pass" },
      "clean-code": { decision: "block", findings: [{ class: "logic-error", lens: "correctness" }] },
    });
    const r = await runSuite(dir, { gateFactory: factory });
    const byId = Object.fromEntries(r.cases.map((c) => [c.id, c]));
    expect(byId["incident-auth"]?.passed).toBe(false);
    expect(byId["incident-auth"]?.reasons[0]).toMatch(/blocked for the wrong reason.*raised: style@src\/x.ts/);
    expect(byId["clean-code"]?.reasons).toEqual(["expected pass, got block"]);
    expect(r.summary.falseBlockRate).toBe(0.5);
    expect(r.summary.ok).toBe(false);
    expect(r.summary.gateFailures.join(" ")).toMatch(/false-block rate 50% is above maxFalseBlock 10%/);
  });

  it("dry mode never calls reviewChange and checks tier/triage", async () => {
    const { factory, calls } = scriptedGateFactory(GOOD);
    const r = await runSuite(dir, { gateFactory: factory, dry: true });
    expect(calls.review).toEqual([]);
    expect(calls.estimate).toHaveLength(3);
    expect(r.cases.every((c) => c.passed)).toBe(true);
    expect(r.cases.find((c) => c.id === "incident-auth")?.actual).toMatchObject({ status: "dry", decision: "not-run" });
    expect(r.summary).toMatchObject({ dry: true, recall: null, falseBlockRate: null, ok: true });
  });

  it("dry mode defaults to the real-stage estimate gate", async () => {
    const r = await runSuite(dir, { dry: true });
    expect(r.cases.find((c) => c.id === "incident-auth")?.actual.lenses).toContain("security");
    await expect(runSuite(dir, {})).rejects.toThrow(/gateFactory is required/);
  });

  it("dry mode fails an expected block that triage would auto-pass", async () => {
    await writeSuite(dir, SUITE_YML, [
      {
        id: "sneaky",
        yaml: "id: sneaky\ntitle: s\nkind: incident\nexpected: { decision: block }\nsource: { type: fixture }\n",
        base: { "README.md": "a\n" },
        head: { "README.md": "b\n" },
      },
    ]);
    const r = await runSuite(dir, { dry: true, filter: { ids: ["sneaky"] } });
    expect(r.cases[0]?.passed).toBe(false);
    expect(r.cases[0]?.reasons[0]).toMatch(/triage auto-passes a change that must block/);
    expect(r.summary.ok).toBe(false);
  });

  it("filters by id and kind and rejects unknown ids", async () => {
    const { factory } = scriptedGateFactory(GOOD);
    const byKind = await runSuite(dir, { gateFactory: factory, filter: { kinds: ["clean"] } });
    expect(byKind.cases.map((c) => c.id)).toEqual(["clean-code", "clean-docs"]);
    const byId = await runSuite(dir, { gateFactory: factory, filter: { ids: ["incident-auth"] } });
    expect(byId.cases.map((c) => c.id)).toEqual(["incident-auth"]);
    await expect(runSuite(dir, { gateFactory: factory, filter: { ids: ["nope"] } })).rejects.toThrow(/unknown case id/);
  });

  it("records gate errors as failed cases and keeps the estimate", async () => {
    const { factory } = scriptedGateFactory({
      ...GOOD,
      "incident-auth": { decision: "block", throws: "provider down" },
    });
    const r = await runSuite(dir, { gateFactory: factory, concurrency: 3 });
    const inc = r.cases.find((c) => c.id === "incident-auth");
    expect(inc?.actual).toMatchObject({ status: "error", error: "provider down", tier: 3 });
    expect(inc?.reasons).toEqual(["gate error: provider down"]);
    expect(r.summary.errors).toBe(1);
    expect(r.summary.recall).toBe(0);
    expect(r.summary.ok).toBe(false);
  });

  it("builds a fresh gate, store and ledger per case and passes the merged policy", async () => {
    await writeTree(dir, {
      "suite.yml": "version: 1\nname: s\ndefaults:\n  policy: { triage: { maxLines: 500 } }\n",
    });
    const stores = new Set<unknown>();
    const ledgers = new Set<unknown>();
    const maxLines: number[] = [];
    const factory: GateFactory = (policy, ctx) => {
      stores.add(ctx.store);
      ledgers.add(ctx.ledger);
      maxLines.push(policy.triage.maxLines);
      const gate: EvalGate = {
        estimate: (change) => estimateWithStages(change, policy),
        async reviewChange() {
          throw new Error("not used");
        },
      };
      return gate;
    };
    const r = await runSuite(dir, { gateFactory: factory, dry: true, policyOverride: { triage: { maxFiles: 9 } } });
    expect(stores.size).toBe(3);
    expect(ledgers.size).toBe(3);
    expect(maxLines).toEqual([500, 500, 500]);
    // maxLines 500 makes the 41-line change small enough to auto-pass, which this case does not expect.
    expect(r.cases.find((c) => c.id === "clean-code")?.passed).toBe(false);
  });

  it("supports diff sources with recorded patches", async () => {
    const diff = (await import("./diff.js")).diffTrees;
    const d = await diff(join(dir, "incident-auth", "base"), join(dir, "incident-auth", "head"));
    await writeTree(dir, {
      "from-diff/change.diff": d.diff,
      "from-diff/case.yml":
        "id: from-diff\ntitle: d\nkind: regression\nexpected: { decision: block, tier: 3 }\nsource: { type: diff, diff: change.diff }\n",
    });
    const r = await runSuite(dir, { dry: true, filter: { ids: ["from-diff"] } });
    expect(r.cases[0]?.actual.tier).toBe(3);
    expect(r.cases[0]?.passed).toBe(true);
    expect(await readFile(join(dir, "from-diff/change.diff"), "utf8")).toContain("src/auth/login.ts");
  });

  it("errors github cases without a token", async () => {
    await writeTree(dir, {
      "gh/case.yml":
        "id: gh\ntitle: g\nkind: incident\nexpected: { decision: block }\nsource: { type: github, repo: acme/web, pr: 7 }\n",
    });
    const r = await runSuite(dir, { dry: true, filter: { ids: ["gh"] } });
    expect(r.cases[0]?.actual.status).toBe("error");
    expect(r.cases[0]?.actual.error).toMatch(/token required/);
  });
});

describe("evaluateCase", () => {
  const spec = parseCase({
    id: "x",
    title: "x",
    kind: "regression",
    expected: { decision: "block", tier: 2, lenses: ["perf"], findingClasses: ["lock-risk"], files: ["a.ts"] },
    source: { type: "fixture" },
  });
  it("lists every failed check", () => {
    const r = evaluateCase(spec, {
      decision: "pass",
      tier: 1,
      triage: "review",
      findings: [],
      cost: {},
      seats: 2,
      lenses: ["correctness"],
      models: [],
      status: "ok",
    });
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual([
      "expected tier 2, got tier 1",
      "expected lenses not seated: perf (seated: correctness)",
      "expected block, got pass",
    ]);
  });
  it("ignores pre-existing findings and requires the file", () => {
    const base = {
      decision: "block" as const,
      tier: 2 as const,
      findings: [],
      cost: {},
      seats: 1,
      lenses: ["perf"],
      models: [],
      status: "ok" as const,
    };
    const pre = evaluateCase(spec, {
      ...base,
      findings: [{ class: "lock-risk", severity: "pre-existing", file: "a.ts", lenses: ["perf"], models: [] }],
    });
    expect(pre.passed).toBe(false);
    const other = evaluateCase(spec, {
      ...base,
      findings: [{ class: "lock-risk", severity: "blocker", file: "b.ts", lenses: ["perf"], models: [] }],
    });
    expect(other.passed).toBe(false);
    const hit = evaluateCase(spec, {
      ...base,
      findings: [{ class: "lock-risk", severity: "important", file: "a.ts", lenses: ["perf"], models: [] }],
    });
    expect(hit.passed).toBe(true);
  });
});
