import { describe, expect, it } from "vitest";
import { makeChange, makeFile, makePolicy, makeTier } from "./test-helpers.js";
import { tier } from "./tiering.js";
import { triage } from "./triage.js";

const policy = makePolicy();
const run = (files: Array<string | ReturnType<typeof makeFile>>, p = policy) => {
  const change = makeChange({ files });
  return triage(change, tier(change, p), p);
};

describe("triage", () => {
  it("reviews anything above tier 0", () => {
    const change = makeChange({ files: ["README.md"] });
    expect(triage(change, makeTier({ level: 1 }), policy)).toEqual({
      decision: "review",
      reason: "tier 1 always gets a review panel",
    });
  });

  it("reviews an empty change", () => {
    const r = run([]);
    expect(r.decision).toBe("review");
    expect(r.reason).toContain("no files");
  });

  it("auto-passes docs-only, assets-only and lockfile-only changes", () => {
    expect(run([makeFile("README.md", { additions: 60 }), "docs/guide/setup.md"])).toMatchObject({
      decision: "auto-pass",
      reason: "docs-only change (2 files)",
    });
    expect(run([makeFile("public/logo.png", { additions: 0 }), "a/b/icon.svg", "x.webp", "Y.GIF"])).toMatchObject({
      decision: "auto-pass",
      reason: "assets-only change (4 files)",
    });
    expect(
      run([makeFile("package-lock.json", { additions: 4000 }), "apps/web/yarn.lock", "x/go.sum", "Cargo.lock"]),
    ).toMatchObject({ decision: "auto-pass", reason: "lockfile-only change (4 files)" });
  });

  it("still reviews a docs change big enough to leave tier 0", () => {
    expect(run([makeFile("README.md", { additions: 2000 })])).toEqual({
      decision: "review",
      reason: "tier 1 always gets a review panel",
    });
  });

  it("respects the per-category toggles", () => {
    const p = makePolicy({ triage: { docsOnlyAutoPass: false } });
    expect(run([makeFile("README.md", { additions: 60 })], p).decision).toBe("review");
    const q = makePolicy({ triage: { lockfileOnlyAutoPass: false } });
    expect(run([makeFile("package-lock.json", { additions: 4000 })], q).decision).toBe("review");
  });

  it("does not call a rename from code into docs docs-only", () => {
    const r = run([makeFile("docs/x.md", { previousPath: "src/x.ts", status: "renamed", additions: 200 })]);
    expect(r.decision).toBe("review");
  });

  it("auto-passes small changes within the limits", () => {
    const r = run([makeFile("src/a.ts", { additions: 10, deletions: 5 }), makeFile("src/b.ts", { additions: 15 })]);
    expect(r).toEqual({
      decision: "auto-pass",
      reason: "small change: 30 lines across 2 files (limits 30 lines, 3 files)",
    });
  });

  it("reviews tier 0 changes over the line or file limit", () => {
    expect(run([makeFile("src/a.ts", { additions: 31 })]).decision).toBe("review");
    expect(run(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]).decision).toBe("review");
  });

  it("counts ignorePaths toward triage size even though tiering ignores them", () => {
    const r = run([makeFile("src/a.ts", { additions: 1 }), makeFile("vendor/lib/x.js", { additions: 900 })]);
    expect(r.decision).toBe("review");
  });

  it("reviews when the tier carries a critical hit or flag removal", () => {
    const change = makeChange({ files: ["src/a.ts"] });
    const crit = makeTier({ level: 0, factors: { loc: 1, files: 1, modules: 1, criticalPathHits: ["**/x/**"] } });
    expect(triage(change, crit, policy).decision).toBe("review");
    const flags = makeTier({
      level: 0,
      factors: { loc: 1, files: 1, modules: 1, criticalPathHits: [], flagRemovals: ["src/a.ts: useFlag('x')"] },
    });
    expect(triage(change, flags, policy).decision).toBe("review");
  });

  it("reviews when the file list is truncated", () => {
    const change = makeChange({ files: ["README.md"] });
    change.stats.files = 10;
    expect(triage(change, makeTier({ level: 0 }), policy).decision).toBe("review");
  });

  it("reviews binaries, mode changes and symlinks that report zero lines", () => {
    const bin = [makeFile("bin/tool.so", { additions: 0, deletions: 0 }), makeFile("lib/vendor.jar", { additions: 0 })];
    const r = run(bin);
    expect(r.decision).toBe("review");
    expect(r.reason).toContain("bin/tool.so");
    expect(run([makeFile("scripts/run.sh", { additions: 0, deletions: 0, status: "modified" })]).decision).toBe(
      "review",
    );
  });

  it("still auto-passes zero-line asset files", () => {
    expect(run([makeFile("public/Logo.PNG", { additions: 0, deletions: 0 })]).decision).toBe("auto-pass");
  });

  it("allows zero-line files that carry a patch", () => {
    expect(run([makeFile("src/a.ts", { additions: 0, deletions: 0, patch: "@@ -1 +1 @@" })]).decision).toBe(
      "auto-pass",
    );
  });

  it("ignores draft status", () => {
    const files = [makeFile("src/a.ts", { additions: 3 })];
    const a = makeChange({ files, draft: true });
    const b = makeChange({ files, draft: false });
    expect(triage(a, tier(a, policy), policy)).toEqual(triage(b, tier(b, policy), policy));
  });
});
