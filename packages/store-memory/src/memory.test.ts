import * as t from "vitest";
import { describe, expect, it } from "vitest";
import { costLedgerContract, verdictStoreContract } from "./contract.js";
import { FIXTURE_REPO, makeVerdict } from "./fixtures.js";
import { memoryCostLedger, memoryVerdictStore } from "./memory.js";
import { usdToMicros } from "./money.js";

verdictStoreContract(t, "memory", async () => ({ store: memoryVerdictStore() }));
costLedgerContract(t, "memory", async (clock) => ({ ledger: memoryCostLedger({ now: clock.now }) }));

describe("memory store specifics", () => {
  it("returns copies so callers cannot mutate stored verdicts", async () => {
    const store = memoryVerdictStore();
    const v = makeVerdict();
    await store.put(v, { version: null });
    v.decision = "block";
    const got = await store.get(v);
    expect(got?.verdict.decision).toBe("pass");
    if (got) got.verdict.decision = "block";
    expect((await store.get(v))?.verdict.decision).toBe("pass");
    expect((await store.listForChange(FIXTURE_REPO, 1))[0]?.decision).toBe("pass");
  });

  it("usdToMicros snaps float noise and otherwise rounds up", () => {
    expect(usdToMicros(0.1)).toBe(100_000);
    expect(usdToMicros(0.3)).toBe(300_000);
    expect(usdToMicros(1234.567891)).toBe(1_234_567_891);
    expect(usdToMicros(0.0000004)).toBe(1);
    expect(usdToMicros(0.0000011)).toBe(2);
    expect(usdToMicros(0)).toBe(0);
    expect(() => usdToMicros(-0.01)).toThrow();
  });

  it("runtime modules never import vitest and have no top-level await", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["contract.ts", "index.ts", "memory.ts", "fixtures.ts", "key.ts", "money.ts"]) {
      const src = await readFile(new URL(f, import.meta.url), "utf8");
      const lines = src.split("\n");
      expect(
        lines.filter((l) => /["']vitest["']/.test(l) && !/^import type |^\s*(\/?\*|\/\/)/.test(l)),
        f,
      ).toEqual([]);
      expect(
        lines.filter((l) => /^(export\s+)?(const|let|var)\s+\w+\s*=\s*await\b|^await\b/.test(l)),
        f,
      ).toEqual([]);
    }
  });
});
