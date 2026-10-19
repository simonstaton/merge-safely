# @merge-safely/store-memory

In-memory `VerdictStore` and `CostLedger`, plus the shared contract suites every store implementation runs.

```ts
import { memoryCostLedger, memoryVerdictStore } from "@merge-safely/store-memory";

const verdicts = memoryVerdictStore();
const ledger = memoryCostLedger({ now: () => new Date() });
```

- **Verdicts**: keyed by `(host, owner, name, number, headSha)`, all compared case-insensitively (GitHub names are
  case-insensitive, so a pass can never sit beside a block under different casing). Stored verdicts keep their casing.
  `put` is compare-and-set against an opaque version (`expect.version` is `null` to create). A failed `put` returns
  `ok: false` with the currently stored version (`""` when nothing is stored). Values are deep-copied in and out.
- **Ledger**: usd is held as integer micro-dollars, rounded up (never down), so sums are exact and never under-count.
  `append` throws on a negative or non-finite usd or on token counts that are not non-negative integers. `reset(id)` records the current all-time totals
  as a baseline and `allTime` reports spend above it; `forChange` and `forWindow` are unaffected. Entries without an
  `installationId` count toward `forChange` only. An `at` in the future (clock skew) or unparseable is recorded at
  append time, so spend is never excluded from a window.
- Nothing survives a restart. Use `store-fs` or `store-sqlite` for anything real.

## Contract suites

```ts
import { costLedgerContract, verdictStoreContract } from "@merge-safely/store-memory";
import * as t from "vitest";

verdictStoreContract(t, "mine", async () => ({ store, close }));
costLedgerContract(t, "mine", async (clock) => ({ ledger: makeLedger({ now: clock.now }), close }));
```

Call them at the top level of a vitest test file. The vitest API is passed in, so this package never imports vitest at
runtime. `key.ts` and `money.ts` are the canonical shared helpers: store-fs and store-sqlite hold byte-identical
copies, and a test in each fails if they drift. `makeVerdict`, `makeCostEntry`, `fakeClock` and `FIXTURE_REPO` are exported for extra tests.
