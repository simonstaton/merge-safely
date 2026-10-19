import { describe, expect, it } from "vitest";
import { costLedgerContract, verdictStoreContract } from "./contract.js";
import { FIXTURE_REPO, makeCostEntry, makeVerdict } from "./fixtures.js";
import { memoryCostLedger, memoryVerdictStore } from "./memory.js";
import { usdToMicros } from "./money.js";

verdictStoreContract("memory", async () => ({ store: memoryVerdictStore() }));
costLedgerContract("memory", async (clock) => ({ ledger: memoryCostLedger({ now: clock.now }) }));

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

  it("rejects non-finite usd", async () => {
    const ledger = memoryCostLedger();
    await expect(ledger.append(makeCostEntry({ usd: Number.NaN }))).rejects.toThrow(/finite/);
  });

  it("usdToMicros rounds to the nearest micro-dollar", () => {
    expect(usdToMicros(0.1)).toBe(100_000);
    expect(usdToMicros(0.0000004)).toBe(0);
  });
});
