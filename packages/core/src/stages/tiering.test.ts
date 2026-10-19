import { describe, expect, it } from "vitest";
import { makeChange, makeFile, makePolicy } from "./test-helpers.js";
import { diffLines, findFlagRemovals, moduleOf, tier } from "./tiering.js";

const policy = makePolicy();
const files = (n: number, lines: number, dir = "src/app") =>
  Array.from({ length: n }, (_, i) => makeFile(`${dir}/f${i}.ts`, { additions: lines, deletions: 0 }));

describe("moduleOf", () => {
  it("uses the first two directory segments", () => {
    expect(moduleOf("packages/core/src/x.ts")).toBe("packages/core");
    expect(moduleOf("src/a.ts")).toBe("src");
    expect(moduleOf("README.md")).toBe(".");
  });
});

describe("tier", () => {
  it("puts a small change in tier 0", () => {
    const t = tier(makeChange({ files: files(3, 10) }), policy);
    expect(t.level).toBe(0);
    expect(t.factors).toMatchObject({ loc: 30, files: 3, modules: 1, criticalPathHits: [] });
    expect(t.score).toBeLessThan(policy.tiers.thresholds.t1);
    expect(t.reasons[0]).toContain("30 lines changed across 3 files in 1 module");
  });

  it("scales tiers with size", () => {
    const medium = tier(makeChange({ files: [...files(4, 25, "src/a"), ...files(4, 25, "lib/b/c")] }), policy);
    expect(medium.level).toBe(1);
    const large = tier(
      makeChange({
        files: [
          ...files(5, 160, "a/x"),
          ...files(5, 160, "b/x"),
          ...files(5, 160, "c/x"),
          ...files(5, 160, "d/x"),
          ...files(5, 160, "e/x"),
        ],
      }),
      policy,
    );
    expect(large.level).toBe(2);
    const huge = tier(
      makeChange({
        files: Array.from({ length: 200 }, (_, i) => makeFile(`m${i % 30}/x/f${i}.ts`, { additions: 50 })),
      }),
      policy,
    );
    expect(huge.level).toBe(3);
    expect(huge.score).toBeLessThanOrEqual(100);
  });

  it("forces tier 3 on a critical path hit with a readable reason", () => {
    const t = tier(makeChange({ files: ["db/migrations/0012_add.sql"] }), policy);
    expect(t.level).toBe(3);
    expect(t.factors.criticalPathHits).toContain("**/migrations/**");
    expect(t.reasons).toContain("touches critical path **/migrations/** (db/migrations/0012_add.sql)");
    expect(t.reasons.some((r) => r.startsWith("tier 3 forced by critical path hit"))).toBe(true);
  });

  it("does not treat author as auth", () => {
    expect(tier(makeChange({ files: ["src/author/bio.ts"] }), policy).level).toBe(0);
    expect(tier(makeChange({ files: ["src/auth/login.ts"] }), policy).level).toBe(3);
  });

  it("counts a rename out of a critical path", () => {
    const t = tier(
      makeChange({ files: [makeFile("src/legacy/x.ts", { previousPath: "src/auth/x.ts", status: "renamed" })] }),
      policy,
    );
    expect(t.level).toBe(3);
  });

  it("summarises multiple examples for one pattern", () => {
    const t = tier(makeChange({ files: ["src/auth/a.ts", "src/auth/b.ts"] }), policy);
    expect(t.reasons).toContain("touches critical path **/auth/** (src/auth/a.ts, +1 more)");
  });

  it("excludes ignorePaths from size but still notes them", () => {
    const t = tier(makeChange({ files: [makeFile("package-lock.json", { additions: 5000 }), "src/a.ts"] }), policy);
    expect(t.factors.loc).toBe(1);
    expect(t.factors.files).toBe(1);
    expect(t.level).toBe(0);
    expect(t.reasons.some((r) => r.includes("ignored for sizing"))).toBe(true);
  });

  it("sizes from stats when the file list is truncated", () => {
    const change = makeChange({ files: ["src/a.ts"] });
    change.stats = { additions: 4000, deletions: 1000, files: 3000 };
    const t = tier(change, policy);
    expect(t.factors.files).toBe(3000);
    expect(t.factors.loc).toBe(5000);
    expect(t.reasons.some((r) => r.includes("truncated"))).toBe(true);
  });

  it("maps thresholds to levels", () => {
    const strict = makePolicy({ tiers: { thresholds: { t1: 1, t2: 2, t3: 3 } } });
    expect(tier(makeChange({ files: files(3, 10) }), strict).level).toBe(3);
    const lax = makePolicy({ tiers: { thresholds: { t1: 100, t2: 100, t3: 100 } } });
    expect(tier(makeChange({ files: files(50, 100) }), lax).level).toBe(0);
  });

  it("is monotonic: more lines, files or modules never lower the score", () => {
    let prev = -1;
    for (let n = 0; n <= 60; n++) {
      const t = tier(makeChange({ files: files(1 + n, 1 + n * 7, `m${n % 7}/x`) }), policy);
      expect(t.score).toBeGreaterThanOrEqual(prev);
      prev = t.score;
    }
    for (let n = 1; n < 40; n++) {
      const base = makeChange({ files: files(n, 20) });
      const more = makeChange({ files: [...files(n, 20), makeFile(`z${n}/y/extra.ts`, { additions: 5 })] });
      expect(tier(more, policy).score).toBeGreaterThanOrEqual(tier(base, policy).score);
    }
  });

  describe("flag removals", () => {
    const patch = (removed: string, added = "") =>
      ["@@ -1,3 +1,3 @@", ` context`, `-${removed}`, ...(added ? [`+${added}`] : [])].join("\n");

    it("forces tier 3 when a flag read is removed", () => {
      const t = tier(
        makeChange({
          files: [makeFile("src/checkout.ts", { patch: patch('  if (isEnabled("new-checkout")) {', "  {") })],
        }),
        policy,
      );
      expect(t.level).toBe(3);
      expect(t.factors.flagRemovals).toEqual(['src/checkout.ts: isEnabled("new-checkout")']);
      expect(t.reasons).toContain('removes feature-flag read src/checkout.ts: isEnabled("new-checkout")');
    });

    it("ignores a flag read that was only reformatted or moved in the same file", () => {
      const t = tier(
        makeChange({
          files: [
            makeFile("src/checkout.ts", {
              patch: patch(`if (isEnabled( 'new-checkout' )) {`, `if (ready && isEnabled("new-checkout")) {`),
            }),
          ],
        }),
        policy,
      );
      expect(t.factors.flagRemovals).toEqual([]);
      expect(t.level).toBe(0);
    });

    it("does not force tier 3 when flagRemovalIsCritical is off, but still adds to the score", () => {
      const p = makePolicy({ tiers: { flagRemovalIsCritical: false } });
      const withFlag = makeChange({
        files: [makeFile("src/a.ts", { patch: patch("posthog.isFeatureEnabled('x')") })],
      });
      const t = tier(withFlag, p);
      expect(t.level).toBe(0);
      expect(t.factors.flagRemovals?.length).toBe(1);
      const without = tier(makeChange({ files: [makeFile("src/a.ts", { patch: patch("foo()") })] }), p);
      expect(t.score).toBeGreaterThan(without.score);
    });

    it("ignores diff file headers and added lines", () => {
      const p = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1 @@", "+useFlag('x')"].join("\n");
      expect(diffLines(p)).toEqual({ removed: [], added: ["useFlag('x')"] });
      expect(findFlagRemovals(makeFile("src/x.ts", { patch: p }), [/useFlag\s*\(/g])).toEqual([]);
    });

    it("survives an invalid policy regex", () => {
      const p = makePolicy({ tiers: { flagReadPatterns: ["(unclosed", "\\bgetFlag\\s*\\("] } });
      const t = tier(makeChange({ files: [makeFile("src/a.ts", { patch: patch("getFlag('beta')") })] }), p);
      expect(t.factors.flagRemovals).toEqual(["src/a.ts: getFlag('beta')"]);
    });
  });
});
