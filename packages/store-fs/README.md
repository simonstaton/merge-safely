# @merge-safely/store-fs

Filesystem `VerdictStore` and `CostLedger`. No database, no native modules. Directories are created on demand.

```ts
import { fsCostLedger, fsVerdictStore } from "@merge-safely/store-fs";

const verdicts = fsVerdictStore(".merge-safely");
const ledger = fsCostLedger(".merge-safely");
```

## Verdicts

- One JSON file per verdict: `<dir>/verdicts/<host>/<owner>/<name>/<number>/<sha>.json`. Every segment is
  lower-cased (GitHub names are case-insensitive) and percent-encoded (dots too), so untrusted repo names cannot
  escape `dir`. The verdict inside keeps its original casing.
- The version is the sha256 of the file's bytes. Each write carries a fresh nonce, so versions never repeat even when
  the same verdict is written twice.
- Creates commit with `link(tmp, file)`, which fails atomically if the file exists, so two creators can never both win.
  Replaces use temp file, fsync, rename. The directory is fsynced after either.
- Compare-and-set is serialised by an in-process mutex per key **and** a `<file>.lock`. The lock is created atomically
  with its owner token already inside (temp + `link`). A lock older than 30 s is presumed left by a crashed process.
  Breakers are serialised by `<file>.lock.break`; the stale lock is renamed to a unique tombstone and its token
  re-checked before being discarded, and a lock taken by mistake is linked back. The holder re-verifies its token
  immediately before committing. Waiting times out after 35 s, longer than the stale threshold
  (`{ lock: { staleMs, timeoutMs } }`).
- `STORE_FS_STRESS_TRIALS=200 npx vitest run packages/store-fs -t "stale-lock stress"` runs the stale-lock race
  stress test longer than CI does.
- A corrupt verdict file makes `get` throw rather than look missing, so it can never be silently overwritten.

## Ledger

- Append-only JSONL per installation at `<dir>/ledger/<installationId or "_">.jsonl`. Each line is the entry plus its
  `usdMicros` (rounded up) and recorded `atMs` (clamped to append time). Invalid entries are rejected on append.
- Sums stream the files and add integer micro-dollars. A torn trailing line from a crash is skipped on read and fenced
  off with a newline on the next append.
- `reset(id)` stores the current all-time totals as a baseline in `<dir>/ledger/rollups.json`; `allTime` reports spend
  above it. Rows are never deleted, so `forChange` and `forWindow` are unaffected.
- `forChange` scans every installation file. That is fine for the Action and the CLI; long-running services that need
  compaction should use `store-sqlite`.

Use local disk. Lock files and rename semantics are not reliable over network filesystems.
