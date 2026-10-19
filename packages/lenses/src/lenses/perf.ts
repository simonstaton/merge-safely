import type { Lens } from "../types.js";
import { commandHint, DATA_PATH, focusBlock, pathsMatching, startWith } from "./helpers.js";

export const perfLens: Lens = {
  id: "perf",
  title: "Performance",
  question: "Query counts, N+1, locks, signatures per request, bundle size.",
  classes: [
    "n-plus-one",
    "lock-risk",
    "unbounded-scan",
    "missing-index",
    "unbounded-memory",
    "blocking-io",
    "per-request-overhead",
    "bundle-bloat",
  ],
  preferredModelTier: "mid",
  focus: (input) =>
    focusBlock({
      tools:
        "read the changed code and every query or remote call it makes, grep for where it is called from to find hot paths (request handlers, loops, renders, jobs), read schema and index definitions for touched tables.",
      checks: [
        "Count queries and remote calls per request or per item. A call inside a loop, map or render over a collection is an N+1 until proven otherwise.",
        "Scans: queries without a selective WHERE, missing LIMIT or pagination, filters or sorts on unindexed columns. Check the index actually exists in the schema.",
        "Locks: long transactions, row or table locks held across remote calls, migrations that rewrite or lock large tables, hot-row contention.",
        "Memory: loading whole tables or files, unbounded caches, arrays that grow with user data, missing streaming.",
        "Per-request overhead: crypto, signing, JSON parsing, regex compilation, client construction or config reads that could be done once.",
        "Blocking: sync I/O or CPU-heavy work on the event loop or main thread.",
        "Frontend: new heavy dependencies, eager imports of large modules, re-render storms from unstable props or effects.",
        "Size it: estimate the volume (rows, items, requests per second) from schema, fixtures or config. A cost that cannot matter at real volume is not a finding.",
        commandHint(input, "measure where a measurement is cheap"),
      ],
      hints: startWith("Data-access files changed", pathsMatching(input, DATA_PATH)),
      evidence:
        "file:line of the expensive call and its caller, the multiplier (loop, request rate, row count) and how you estimated it.",
    }),
};
