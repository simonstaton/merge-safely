import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_CASES, SUITE_YML, tempDir, writeSuite, writeTree } from "../test/helpers.js";
import {
  casePolicyInput,
  loadSuite,
  mergePolicyFragments,
  parseCase,
  parseSuiteManifest,
  SuiteValidationError,
} from "./suite.js";

const baseCase = {
  id: "c1",
  title: "t",
  kind: "incident",
  expected: { decision: "block" },
  source: { type: "fixture" },
};

describe("parseSuiteManifest", () => {
  it("applies gate defaults", () => {
    const m = parseSuiteManifest({ version: 1, name: "s" });
    expect(m.gates).toEqual({ minRecall: 0.8, maxFalseBlock: 0.1 });
  });

  it("rejects unknown keys and wrong versions with paths", () => {
    expect(() => parseSuiteManifest({ version: 2, name: "s" })).toThrow(/version/);
    try {
      parseSuiteManifest({ version: 1, name: "s", gates: { minRecall: 2 }, extra: true });
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SuiteValidationError);
      const issues = (err as SuiteValidationError).issues.join("\n");
      expect(issues).toMatch(/gates\.minRecall/);
      expect(issues).toMatch(/extra/);
    }
  });
});

describe("parseCase", () => {
  it("defaults fixture dirs", () => {
    const c = parseCase(baseCase);
    expect(c.source).toEqual({ type: "fixture", base: "base/", head: "head/" });
  });

  it("parses diff and github sources", () => {
    expect(parseCase({ ...baseCase, source: { type: "diff", diff: "change.diff" } }).source.type).toBe("diff");
    const gh = parseCase({
      ...baseCase,
      source: { type: "github", repo: "acme/web", pr: 12, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(gh.source).toMatchObject({ repo: "acme/web", pr: 12, includeComments: false });
    expect(() =>
      parseCase({ ...baseCase, source: { type: "github", repo: "acme/web", pr: 12, headSha: "abc1234" } }),
    ).toThrow(/full commit SHA/);
  });

  it("enforces kind/decision consistency", () => {
    expect(() => parseCase({ ...baseCase, expected: { decision: "pass" } })).toThrow(
      /incident cases must expect block/,
    );
    expect(() => parseCase({ ...baseCase, kind: "clean" })).toThrow(/clean cases must expect pass/);
    expect(() =>
      parseCase({ ...baseCase, kind: "regression", expected: { decision: "pass", findingClasses: ["x"] } }),
    ).toThrow(/only apply to cases expected to block/);
    expect(() => parseCase({ ...baseCase, expected: { decision: "block", triage: "auto-pass" } })).toThrow(
      /cannot expect triage auto-pass/,
    );
  });

  it("rejects bad ids, tiers, paths and repos", () => {
    expect(() => parseCase({ ...baseCase, id: "Bad Id" })).toThrow(/id/);
    expect(() => parseCase({ ...baseCase, expected: { decision: "block", tier: 4 } })).toThrow(/expected\.tier/);
    expect(() => parseCase({ ...baseCase, source: { type: "diff", diff: "../x.diff" } })).toThrow(/relative path/);
    expect(() => parseCase({ ...baseCase, source: { type: "github", repo: "nope", pr: 1 } })).toThrow(/owner\/name/);
    expect(() => parseCase({ ...baseCase, source: { type: "svn" } })).toThrow(/source/);
  });
});

describe("loadSuite", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("loads cases sorted by directory and skips dirs without case.yml", async () => {
    await writeSuite(dir, SUITE_YML, STANDARD_CASES);
    await writeTree(dir, { "notes/README.md": "not a case" });
    const s = await loadSuite(dir);
    expect(s.manifest.name).toBe("test-suite");
    expect(s.cases.map((c) => c.spec.id)).toEqual(["clean-code", "clean-docs", "incident-auth"]);
    expect(s.cases[0]?.dir).toBe(join(dir, "clean-code"));
  });

  it("collects every problem across cases", async () => {
    await writeSuite(dir, SUITE_YML, [
      { id: "a", yaml: "id: dup\ntitle: a\nkind: clean\nexpected: { decision: pass }\nsource: { type: fixture }\n" },
      { id: "b", yaml: "id: dup\ntitle: b\nkind: clean\nexpected: { decision: pass }\nsource: { type: fixture }\n" },
      { id: "c", yaml: "id: c\ntitle: c\nkind: clean\nexpected: { decision: block }\nsource: { type: fixture }\n" },
      {
        id: "d",
        yaml: "id: d\ntitle: d\nkind: clean\nexpected: { decision: pass }\nsource: { type: diff, diff: x.diff }\n",
      },
      { id: "e", yaml: "id: [unclosed\nkind: {" },
    ]);
    const err = await loadSuite(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SuiteValidationError);
    const issues = (err as SuiteValidationError).issues.join("\n");
    expect(issues).toMatch(/b\/case.yml: id: duplicate case id "dup"/);
    expect(issues).toMatch(/c\/case.yml: expected.decision: clean cases must expect pass/);
    expect(issues).toMatch(/d\/case.yml: source.diff: file x.diff not found/);
    expect(issues).toMatch(/Invalid YAML/);
  });

  it("reports missing fixture dirs, a missing manifest and an empty suite", async () => {
    await expect(loadSuite(dir)).rejects.toThrow(/suite.yml not found/);
    await writeTree(dir, { "suite.yml": SUITE_YML });
    await expect(loadSuite(dir)).rejects.toThrow(/suite has no cases/);
    await writeTree(dir, {
      "x/case.yml":
        "id: x\ntitle: x\nkind: clean\nexpected: { decision: pass }\nsource: { type: fixture, head: tree/ }\n",
    });
    await expect(loadSuite(dir)).rejects.toThrow(/source.base: directory base\/ not found/);
  });
});

describe("load-time registry and path checks", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("rejects finding classes and lenses no registered lens knows, unless the suite declares them", async () => {
    const yaml =
      "id: x\ntitle: x\nkind: incident\nexpected: { decision: block, lenses: [perff], findingClasses: [lock-rsik, my-class] }\nsource: { type: fixture }\n";
    await writeSuite(dir, SUITE_YML, [{ id: "x", yaml, head: { "a.ts": "1\n" } }]);
    const err = (await loadSuite(dir).catch((e: unknown) => e)) as SuiteValidationError;
    expect(err.issues).toEqual([
      expect.stringMatching(/x\/case.yml: expected.findingClasses: unknown class "lock-rsik"/),
      expect.stringMatching(/unknown class "my-class"/),
      'x/case.yml: expected.lenses: unknown lens "perff"',
    ]);
    await writeTree(dir, {
      "suite.yml": `${SUITE_YML}extraFindingClasses: [lock-rsik, my-class]\nextraLenses: [perff]\n`,
    });
    await expect(loadSuite(dir)).resolves.toBeDefined();
  });

  it("rejects symlinked fixture roots and diff files that leave the case directory", async () => {
    await writeTree(dir, { "secret/creds.env": "TOP_SECRET=hunter2\n", "suite.yml": SUITE_YML });
    await writeTree(dir, {
      "a/case.yml": "id: a\ntitle: a\nkind: clean\nexpected: { decision: pass }\nsource: { type: fixture }\n",
      "a/head/x.ts": "1\n",
      "b/case.yml":
        "id: b\ntitle: b\nkind: clean\nexpected: { decision: pass }\nsource: { type: diff, diff: change.diff }\n",
    });
    await symlink(join(dir, "secret"), join(dir, "a", "base"));
    await symlink(join(dir, "secret", "creds.env"), join(dir, "b", "change.diff"));
    const err = (await loadSuite(dir).catch((e: unknown) => e)) as SuiteValidationError;
    expect(err.issues.join("\n")).toMatch(/a\/case.yml: source.base: source.base base\/ is a symlink/);
    expect(err.issues.join("\n")).toMatch(/b\/case.yml: source.diff: source.diff change.diff is a symlink/);
  });
});

describe("policy merging", () => {
  it("deep merges objects and replaces arrays", () => {
    expect(
      mergePolicyFragments(
        { triage: { maxLines: 10, docsPatterns: ["a"] }, quorum: { t1: 1 } },
        { triage: { docsPatterns: ["b"] } },
        undefined,
      ),
    ).toEqual({ triage: { maxLines: 10, docsPatterns: ["b"] }, quorum: { t1: 1 } });
  });

  it("layers suite defaults, models shorthand, case and override", () => {
    const suite = parseSuiteManifest({
      version: 1,
      name: "s",
      defaults: { policy: { triage: { maxLines: 5 } }, models: { decorrelate: false } },
    });
    const spec = parseCase({ ...baseCase, policy: { triage: { maxFiles: 1 } } });
    expect(casePolicyInput(suite, spec, { triage: { maxLines: 7 } })).toEqual({
      triage: { maxLines: 7, maxFiles: 1 },
      models: { decorrelate: false },
    });
  });
});
