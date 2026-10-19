# @merge-safely/store-fs

Filesystem `VerdictStore` and `CostLedger`. No database, no native modules. Directories are created on demand.

```ts
import { fsCostLedger, fsVerdictStore } from "@merge-safely/store-fs";

const verdicts = fsVerdictStore(".merge-safely");
const ledger = fsCostLedger(".merge-safely");
```

## Verdicts

- One JSON file per verdict: `<dir>/verdicts/<host>/<owner>/<name>/<number>/<sha>.json`. Every segment is
  percent-encoded (dots too), so untrusted repo names cannot escape `dir`. Host and SHA are lower-cased.
- The version is the sha256 of the file's bytes. Each write carries a fresh nonce, so versions never repeat even when
  the same verdict is written twice.
- Writes are atomic: temp file, fsync, rename.
- Compare-and-set is serialised by an in-process mutex per key **and** a `<file>.lock` created with `wx`, so separate
  processes sharing the directory do not interleave. A lock older than 30 s is treated as left by a crashed process
  and broken. Waiting for a live lock times out after 10 s (both configurable via `{ lock: { staleMs, timeoutMs } }`).
- A corrupt verdict file makes `get` throw rather than look missing, so it can never be silently overwritten.

## Ledger

- Append-only JSONL per installation at `<dir>/ledger/<installationId or "_">.jsonl`. Each line is the entry plus its
  exact `usdMicros` and parsed `atMs`.
- Sums stream the files and add integer micro-dollars. A torn trailing line from a crash is skipped on read and fenced
  off with a newline on the next append.
- `reset(id)` stores the current all-time totals as a baseline in `<dir>/ledger/rollups.json`; `allTime` reports spend
  above it. Rows are never deleted, so `forChange` and `forWindow` are unaffected.
- `forChange` scans every installation file. That is fine for the Action and the CLI; long-running services that need
  compaction should use `store-sqlite`.

Use local disk. Lock files and rename semantics are not reliable over network filesystems.
