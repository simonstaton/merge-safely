import { type Finding, REVIEWER_OUTPUT_JSON_SCHEMA, type ReviewerInput } from "@merge-safely/core";

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-1a2b3c",
    severity: "important",
    class: "logic-error",
    title: "Discount applied twice when coupon and promo stack",
    detail: "applyDiscount runs in both the cart and checkout paths.",
    file: "src/billing/discount.ts",
    line: 42,
    evidence: ["src/billing/discount.ts:42", "grep applyDiscount: 2 call sites"],
    ...overrides,
  };
}

export function makeInput(overrides: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    change: {
      repo: { host: "github.com", owner: "acme", name: "shop" },
      number: 128,
      headSha: "1111111111111111111111111111111111111111",
      baseSha: "0000000000000000000000000000000000000000",
      baseRef: "main",
      headRef: "fix/double-discount",
      title: "Fix double discount",
      body: "Fixes the double discount bug.",
      author: { kind: "human", login: "dev-a" },
      files: [
        { path: "src/billing/discount.ts", status: "modified", additions: 12, deletions: 4 },
        { path: "src/billing/discount.test.ts", status: "modified", additions: 30, deletions: 0 },
        { path: "db/migrations/0042_add_coupon_index.sql", status: "added", additions: 3, deletions: 0 },
        { path: "src/billing/legacy.ts", status: "removed", additions: 0, deletions: 40 },
      ],
      stats: { additions: 45, deletions: 44, files: 4 },
      labels: [],
      draft: false,
      ciStatus: "success",
    },
    tier: {
      level: 2,
      score: 55,
      factors: { loc: 89, files: 4, modules: 2, criticalPathHits: [] },
      reasons: ["touches billing", "adds a migration"],
    },
    round: 1,
    diff: "diff --git a/src/billing/discount.ts b/src/billing/discount.ts\n@@ -40,3 +40,4 @@\n-  return price;\n+  return applyDiscount(price);\n",
    diffIsDelta: false,
    untrusted: { title: "Fix double discount", body: "Fixes the double discount bug." },
    knownFindings: [],
    allowedCommands: ["npm test -- src/billing"],
    prompt: { system: "", user: "" },
    outputSchema: REVIEWER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    ...overrides,
  };
}
