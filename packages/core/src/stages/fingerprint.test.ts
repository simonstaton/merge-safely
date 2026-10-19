import { describe, expect, it } from "vitest";
import {
  assignFingerprints,
  dedupeFindings,
  fingerprintFinding,
  LINE_WINDOW,
  maxSeverity,
  minSeverity,
  normaliseTitle,
} from "./fingerprint.js";
import { makeFinding } from "./test-helpers.js";

describe("normaliseTitle", () => {
  it("lower-cases, strips punctuation, stopwords and numbers, and sorts", () => {
    expect(normaliseTitle("Missing null-check at line 42!")).toBe("check missing null");
    expect(normaliseTitle("null check MISSING")).toBe("check missing null");
    expect(normaliseTitle("  The  N+1 query in `loadUsers`  ")).toBe("loadusers n query");
    expect(normaliseTitle("")).toBe("");
  });
});

describe("fingerprintFinding", () => {
  it("is 10 hex chars and deterministic", () => {
    const id = fingerprintFinding(makeFinding());
    expect(id).toMatch(/^[0-9a-f]{10}$/);
    expect(fingerprintFinding(makeFinding())).toBe(id);
  });

  it("ignores any id the model supplied, severity, detail and evidence", () => {
    const base = fingerprintFinding(makeFinding());
    expect(
      fingerprintFinding(
        makeFinding({ id: "model-made-up", severity: "nit", detail: "other words", evidence: ["ran x"] }),
      ),
    ).toBe(base);
  });

  it("normalises path, class and title", () => {
    const a = fingerprintFinding(
      makeFinding({ file: "./src/index.ts", class: " Logic-Error ", title: "off-by-one LOOP bound" }),
    );
    expect(a).toBe(fingerprintFinding(makeFinding()));
  });

  it("changes with file, class and line window, but not with title rewording", () => {
    const base = fingerprintFinding(makeFinding());
    expect(fingerprintFinding(makeFinding({ file: "src/other.ts" }))).not.toBe(base);
    expect(fingerprintFinding(makeFinding({ class: "race" }))).not.toBe(base);
    expect(fingerprintFinding(makeFinding({ line: 10 + LINE_WINDOW }))).not.toBe(base);
    expect(fingerprintFinding(makeFinding({ class: "injection", title: "SQL injection in search query" }))).toBe(
      fingerprintFinding(makeFinding({ class: "injection", title: "Unsanitised user input reaches raw SQL" })),
    );
  });

  it("hashes only class and title when there is no file", () => {
    const a = fingerprintFinding(makeFinding({ file: undefined, line: 3 }));
    const b = fingerprintFinding(makeFinding({ file: undefined, line: 300 }));
    expect(a).toBe(b);
    expect(a).not.toBe(fingerprintFinding(makeFinding({ line: undefined })));
    expect(a).not.toBe(fingerprintFinding(makeFinding({ file: undefined, title: "Something else entirely" })));
  });

  it("property: stable under line drift within a window", () => {
    for (let line = 1; line <= 500; line++) {
      const id = fingerprintFinding(makeFinding({ line }));
      const windowStart = Math.floor((line - 1) / LINE_WINDOW) * LINE_WINDOW + 1;
      for (let drift = -LINE_WINDOW; drift <= LINE_WINDOW; drift++) {
        const moved = line + drift;
        if (moved < 1) continue;
        const sameWindow = moved >= windowStart && moved < windowStart + LINE_WINDOW;
        expect(fingerprintFinding(makeFinding({ line: moved })) === id).toBe(sameWindow);
      }
    }
  });

  it("property: file-less findings are stable under title rewording that keeps the same words", () => {
    const words = ["unbounded", "scan", "users", "table", "backfill"];
    const base = fingerprintFinding(makeFinding({ file: undefined, title: words.join(" ") }));
    for (let i = 0; i < 50; i++) {
      const shuffled = [...words].sort(() => ((i * 7919) % 3) - 1);
      const title = `The ${shuffled.join(", ")} at line ${i}`;
      expect(fingerprintFinding(makeFinding({ file: undefined, title }))).toBe(base);
    }
  });
});

describe("assignFingerprints", () => {
  it("overwrites ids", () => {
    const [f] = assignFingerprints([{ ...makeFinding(), id: "bogus" }]);
    expect(f?.id).toBe(fingerprintFinding(makeFinding()));
  });
});

describe("severity helpers", () => {
  it("orders blocker > important > nit > pre-existing", () => {
    expect(maxSeverity("nit", "blocker")).toBe("blocker");
    expect(maxSeverity("pre-existing", "nit")).toBe("nit");
    expect(minSeverity("important", "nit")).toBe("nit");
    expect(minSeverity("blocker", "pre-existing")).toBe("pre-existing");
  });
});

describe("dedupeFindings", () => {
  it("merges duplicates: union lenses/evidence, highest severity, longest detail", () => {
    const [a, b, c] = assignFingerprints([
      makeFinding({ severity: "nit", detail: "short", lenses: ["perf"], evidence: ["e1"] }),
      makeFinding({
        line: 4,
        severity: "blocker",
        detail: "much longer detail",
        lenses: ["correctness"],
        evidence: ["e1", "e2"],
        suggestedFix: "fix",
      }),
      makeFinding({ file: "src/other.ts" }),
    ]);
    if (!a || !b || !c) throw new Error("fixture");
    const out = dedupeFindings([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: a.id,
      severity: "blocker",
      detail: "much longer detail",
      lenses: ["perf", "correctness"],
      evidence: ["e1", "e2"],
      suggestedFix: "fix",
      line: 10,
    });
    expect(out[1]?.id).toBe(c.id);
  });

  it("never trusts a model-supplied id when merging", () => {
    const style = makeFinding({ id: "same", class: "style", title: "Prefer const", severity: "nit" });
    const real = makeFinding({ id: "same", class: "logic-error", file: "src/pay.ts", severity: "blocker" });
    const out = dedupeFindings([style, real]);
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.class === "logic-error")?.severity).toBe("blocker");
  });

  it("fingerprints findings that arrive without an id", () => {
    const out = dedupeFindings([makeFinding(), makeFinding({ line: 3 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(fingerprintFinding(makeFinding()));
  });

  it("does not mutate its input", () => {
    const a = makeFinding({ id: "x", lenses: ["a"] });
    const b = makeFinding({ id: "x", lenses: ["b"], severity: "blocker" });
    dedupeFindings([a, b]);
    expect(a.lenses).toEqual(["a"]);
    expect(a.severity).toBe("important");
  });
});

describe("mergeCrossClassDuplicates", () => {
  it("merges the same bug reported under two classes in one line window", () => {
    const a = {
      severity: "blocker" as const,
      class: "logic-error",
      title: "bulkRefund refunds unpaid (open) orders and counts them in the refunded total",
      detail: "long detail about the missing paid check",
      file: "src/orders.ts",
      line: 24,
      lenses: ["correctness"],
    };
    const b = {
      severity: "important" as const,
      class: "failing-path",
      title: "bulkRefund refunds unpaid open orders and counts them in the refunded total",
      detail: "short",
      file: "src/orders.ts",
      line: 25,
      lenses: ["repro"],
    };
    const merged = dedupeFindings([b, a]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.class).toBe("logic-error");
    expect(merged[0]?.severity).toBe("blocker");
    expect(merged[0]?.lenses?.sort()).toEqual(["correctness", "repro"]);
    expect(merged[0]?.evidence?.some((e) => e.startsWith("also reported as failing-path"))).toBe(true);
  });
  it("merges the reworded pair seen in a real run and keeps the off-by-one apart", () => {
    const a = {
      severity: "important" as const,
      class: "failing-path",
      title: "bulkRefund refunds open (unpaid) orders, not just paid ones",
      detail: "d",
      file: "src/orders.ts",
      line: 24,
      lenses: ["repro"],
    };
    const b = {
      severity: "blocker" as const,
      class: "logic-error",
      title: "bulkRefund refunds unpaid (open) orders and inflates the refunded total",
      detail: "dd",
      file: "src/orders.ts",
      line: 24,
      lenses: ["correctness"],
    };
    const c = {
      severity: "nit" as const,
      class: "off-by-one",
      title: "bulkRefund also refunds an order created exactly at the `before` cutoff",
      detail: "d",
      file: "src/orders.ts",
      line: 24,
      lenses: ["correctness"],
    };
    const merged = dedupeFindings([a, b, c]);
    expect(merged.map((f) => f.class).sort()).toEqual(["logic-error", "off-by-one"]);
  });
  it("never merges two findings from the same lens", () => {
    const a = {
      severity: "important" as const,
      class: "failing-path",
      title: "bulkRefund refunds open unpaid orders",
      detail: "d",
      file: "src/orders.ts",
      line: 24,
      lenses: ["correctness"],
    };
    const b = {
      severity: "blocker" as const,
      class: "logic-error",
      title: "bulkRefund refunds unpaid open orders",
      detail: "dd",
      file: "src/orders.ts",
      line: 24,
      lenses: ["correctness"],
    };
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });
  it("keeps distinct bugs in the same window apart", () => {
    const a = {
      severity: "nit" as const,
      class: "off-by-one",
      title: "Boundary: order created exactly at cutoff is refunded",
      detail: "d",
      file: "src/orders.ts",
      line: 24,
    };
    const b = {
      severity: "important" as const,
      class: "logic-error",
      title: "bulkRefund refunds unpaid open orders",
      detail: "d",
      file: "src/orders.ts",
      line: 24,
    };
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });
});
