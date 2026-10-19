# @merge-safely/store-memory

In-memory `VerdictStore` and `CostLedger`, plus the shared contract suites every store implementation runs.

```ts
import { memoryCostLedger, memoryVerdictStore } from "@merge-safely/store-memory";

const verdicts = memoryVerdictStore();
const ledger = memoryCostLedger({ now: () => new Date() });
```

- **Verdicts**: keyed by `(host, owner, name, number, headSha)`; host and SHA compare case-insensitively.
  `put` is compare-and-set against an opaque version (`expect.version` is `null` to create). A failed `put` returns
  `ok: false` with the currently stored version (`""` when nothing is stored). Values are deep-copied in and out.
- **Ledger**: usd is held as integer micro-dollars, so sums are exact. `reset(id)` records the current all-time totals
  as a baseline and `allTime` reports spend above it; `forChange` and `forWindow` are unaffected. Entries without an
  `installationId` count toward `forChange` only. An unparseable `at` is recorded at append time, never dropped.
- Nothing survives a restart. Use `store-fs` or `store-sqlite` for anything real.

## Contract suites

```ts
import { costLedgerContract, verdictStoreContract } from "@merge-safely/store-memory";

verdictStoreContract("mine", async () => ({ store, close }));
costLedgerContract("mine", async (clock) => ({ ledger: makeLedger({ now: clock.now }), close }));
```

Call them at the top level of a vitest test file. vitest is imported lazily, so importing this package at runtime does
not need it installed. `makeVerdict`, `makeCostEntry`, `fakeClock` and `FIXTURE_REPO` are exported for extra tests.
