import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runSuite } from "./runner.js";
import type { SuiteResult } from "./types.js";

const STARTER = fileURLToPath(new URL("../suites/starter", import.meta.url));

/**
 * A real check: the starter fixtures go through the production tier, triage and seating stages (no models), and
 * must land where each case says. If tiering changes and an incident stops being tier 3, this fails.
 */
describe("starter suite (dry, real core stages)", () => {
  let result: SuiteResult;
  beforeAll(async () => {
    result = await runSuite(STARTER, { dry: true, concurrency: 4 });
  });

  it("has the Appendix A incidents and clean controls", () => {
    expect(result.cases.length).toBeGreaterThanOrEqual(6);
    expect(result.summary.byKind.incident.total).toBeGreaterThanOrEqual(3);
    expect(result.summary.byKind.clean.total).toBeGreaterThanOrEqual(2);
    expect(result.summary.byKind.regression.total).toBeGreaterThanOrEqual(1);
  });

  it("every case passes its dry checks", () => {
    const failures = result.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.reasons.join("; ")}`);
    expect(failures).toEqual([]);
    expect(result.summary.ok).toBe(true);
    expect(result.summary.tierAccuracy).toBe(1);
  });

  it.each([
    ["unbatched-backfill", 3, "review", ["perf", "rollout"]],
    ["missing-flag", 3, "review", ["rollout"]],
    ["shared-layout-prop-drop", 3, "review", ["blast-radius"]],
    ["post-approval-auth-change", 3, "review", ["security"]],
    ["small-bugfix-with-test", 0, "review", ["correctness", "repro"]],
    ["docs-readme-edit", 0, "auto-pass", []],
    ["lockfile-only-bump", 0, "auto-pass", []],
  ] as const)("%s lands in tier %i with triage %s", (id, tier, triage, lenses) => {
    const c = result.cases.find((x) => x.id === id);
    expect(c?.actual.tier).toBe(tier);
    expect(c?.actual.triage).toBe(triage);
    for (const l of lenses) expect(c?.actual.lenses).toContain(l);
    if (triage === "auto-pass") expect(c?.actual).toMatchObject({ decision: "pass", seats: 0 });
  });

  it("forces the flag case to tier 3 by the flag removal, not a critical path", () => {
    const c = result.cases.find((x) => x.id === "missing-flag");
    expect(c?.actual.status).toBe("dry");
    const reasons = c?.actual.tierReasons?.join("\n") ?? "";
    expect(reasons).toMatch(/removes feature-flag read .*isEnabled\("checkout-legacy-fallback"\)/);
    expect(reasons).not.toMatch(/touches critical path/);
    // Seated with the full tier-3 panel even though no critical path is touched.
    expect(c?.actual.lenses).toContain("security");
  });
});
