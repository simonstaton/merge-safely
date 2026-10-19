import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarize } from "../src/report.js";
import type { SuiteGates } from "../src/suite.js";
import type { CaseActual, CaseResult, SuiteResult } from "../src/types.js";

export type Tree = Record<string, string>;

export async function writeTree(root: string, files: Tree): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

export async function tempDir(prefix = "evals-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface FixtureCase {
  id: string;
  yaml: string;
  base?: Tree;
  head?: Tree;
}

/** Write a suite with fixture cases into `dir`. */
export async function writeSuite(dir: string, suiteYaml: string, cases: FixtureCase[]): Promise<void> {
  await writeTree(dir, { "suite.yml": suiteYaml });
  for (const c of cases) {
    await writeTree(join(dir, c.id), { "case.yml": c.yaml });
    await mkdir(join(dir, c.id, "base"), { recursive: true });
    await mkdir(join(dir, c.id, "head"), { recursive: true });
    await writeTree(join(dir, c.id, "base"), c.base ?? {});
    await writeTree(join(dir, c.id, "head"), c.head ?? {});
  }
}

export const SUITE_YML = "version: 1\nname: test-suite\ngates: { minRecall: 0.8, maxFalseBlock: 0.1 }\n";

const lines = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n");

/** Three cases: an incident on a critical path, a docs-only clean change, and a mid-size clean change. */
export const STANDARD_CASES: FixtureCase[] = [
  {
    id: "incident-auth",
    yaml: `id: incident-auth
title: auth bypass
kind: incident
expected: { decision: block, tier: 3, findingClasses: [authn-bypass], files: [src/auth/login.ts] }
source: { type: fixture }
change: { title: tweak login, body: "safe" }
`,
    base: { "src/auth/login.ts": "export const check = (ok: boolean) => ok;\n" },
    head: { "src/auth/login.ts": "export const check = (_ok: boolean) => true;\n" },
  },
  {
    id: "clean-docs",
    yaml: `id: clean-docs
title: docs
kind: clean
expected: { decision: pass, tier: 0, triage: auto-pass }
source: { type: fixture }
`,
    base: { "README.md": "# hi\n" },
    head: { "README.md": "# hi\n\nmore docs\n" },
  },
  {
    id: "clean-code",
    yaml: `id: clean-code
title: code
kind: clean
expected: { decision: pass, tier: 0, triage: review }
source: { type: fixture }
`,
    base: { "src/util/a.ts": "export const x = 1;\n" },
    head: { "src/util/a.ts": `export const x = 1;\n${lines(40, "v")}\n` },
  },
];

export function makeCaseResult(
  over: Partial<Omit<CaseResult, "actual">> & { actual?: Partial<CaseActual> } = {},
): CaseResult {
  const kind = over.kind ?? "incident";
  const expected = over.expected ?? { decision: kind === "clean" ? "pass" : "block" };
  const actual: CaseActual = {
    decision: expected.decision,
    tier: 3,
    triage: "review",
    findings: [],
    cost: { usd: 1 },
    seats: 2,
    lenses: ["perf", "rollout"],
    models: ["model-a"],
    status: "ok",
    ...over.actual,
  };
  return {
    id: over.id ?? "case",
    title: over.title ?? "a case",
    kind,
    expected,
    actual,
    passed: over.passed ?? true,
    reasons: over.reasons ?? [],
    durationMs: over.durationMs ?? 100,
  };
}

export function makeSuiteResult(cases: CaseResult[], opts: { dry?: boolean; gates?: SuiteGates } = {}): SuiteResult {
  const gates = opts.gates ?? { minRecall: 0.8, maxFalseBlock: 0.1 };
  const dry = opts.dry ?? false;
  return { suite: { name: "s", dir: "/tmp/s", gates, dry }, cases, summary: summarize(cases, { gates, dry }) };
}
