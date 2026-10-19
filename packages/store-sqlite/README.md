# @merge-safely/store-sqlite

SQLite `VerdictStore` and `CostLedger` on one database file, using `better-sqlite3`. The default store for the CLI and
self-hosted App.

```ts
import { sqliteStores } from "@merge-safely/store-sqlite";

const { verdicts, ledger, compact, close } = sqliteStores({ path: ".merge-safely/store.db" });
setInterval(() => compact({ olderThanMs: 30 * 24 * 3_600_000 }), 3_600_000).unref();
```

- `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`. Several processes may open the same file. Use local
  disk only: WAL does not work over network filesystems.
- Schema is created on open and versioned with `PRAGMA user_version`. Reopening is idempotent; a database written by a
  newer build is refused rather than misread. v2 adds an index on `cost_entries(at)`.
- **Verdicts**: keys and the `repo_*`/`head_sha` columns are lower-cased (GitHub names are case-insensitive); the JSON
  keeps original casing. Compare-and-set is one `INSERT` (create; only a primary-key violation means lost race, any
  other constraint error is rethrown) or one
  `UPDATE … WHERE key = ? AND version = ?` (replace), inside a `BEGIN IMMEDIATE` transaction. Versions are opaque
  strings that increase per key.
- **Ledger**: usd is stored as integer micro-dollars (`usd_micros`, rounded up) and summed in SQL, so totals are exact.
  Invalid entries are rejected on append. `at` is stored as epoch ms, clamped to append time when in the future. Every row carries installation, change, head SHA, round, seat, lens, connection, provider and model.
- **Compaction**: `compact({ olderThanMs, force })` (default 30 days; under 7 days throws unless `force: true`) folds older rows into per-change rows in `cost_rollups`,
  deletes them, then runs `PRAGMA wal_checkpoint(TRUNCATE)`. `forChange` and `allTime` read rollups plus live rows, so
  compaction never changes them. `forWindow` counts a rollup whole when its newest folded row is inside the window. That
  over-counts and never under-counts, which is the safe direction for a ceiling. With the 7-day minimum (the design's
  longest window), window sums stay exact.
- **Reset**: `reset(id)` writes the installation's current all-time totals to `ledger_resets` as a baseline; `allTime`
  reports spend above it. History is kept, so `forChange` and `forWindow` are unaffected.

## Why the all-time ceiling reads this ledger, never the provider's figure

Design section 7.6 ("Ledger, not estimate"). A provider's account usage is the key's lifetime spend. The gate cannot
reset it, and it includes spend that never went through the gate. Fanbot enforced an all-time limit against
OpenRouter's figure, and any key with prior usage was permanently over the limit with no way to clear it. Here the
ceiling is checked against rows this ledger recorded from the runner's streamed usage deltas. A seat killed at its
deadline has still been recorded, and `reset` clears the counter without losing history. Provider usage is for display
only.
