# @merge-safely/testkit

Fakes for building and testing pipelines on `@merge-safely/core`. Depends only on core. No network.

| Fake | Port | What it gives you |
|---|---|---|
| `fakeProvider(opts)` | `ModelProvider` | Scriptable runner that behaves like the real ones (deadline, `maxUsd`, abort, output role); records `calls`, streams `onUsage`, emits `onToolCall`; default audits pass attestation. |
| `scriptedRuns(spec)`, `scenarios.*` | `Script` | Per-seat behaviours: pass, block, confirm, refute, downgrade, timeout, error, insufficient-work, budget-exceeded. |
| `fakeSource(fixture)` | `SourceProvider` | In-memory change, diff, `diffs` by head SHA, deltas, untrusted context; records `calls`. A pinned `headSha` returns that SHA's diff, like the GitHub source. |
| `fakeWorkspace(opts?)` | `Workspace` | A temp dir per acquire. With git (the default when files are given): a base commit (`baseFiles`, or empty) then a head commit (`files`); `handle.baseSha` is the real base commit, so the tools' `git_diff` works. Tracks `acquired` / `disposed` / `active`. |
| `memoryReporter()`, `memoryEscalation()`, `memoryMetrics()`, `memoryTrust(map)` | Reporter, Escalation, Metrics, TrustProvider | Collect everything for assertions. |
| `fixedClock(iso)`, `silentLogger()` | Clock, Logger | Deterministic time; a logger that keeps entries and prints nothing. |
| `makeChange`, `makeFile`, `diffFromFiles`, `parseUnifiedDiff`, `fakeSha` | | Build fixtures; `diffFromFiles` emits a real unified diff (it applies with `git apply`) and fills `ChangedFile.patch`. |
| `sampleFixtures` | | `docsOnly` (tier 0, triage auto-pass), `smallLogic` (tier 1: ~100 lines over 3 modules, no critical path), `authMigration` (tier 3: `src/auth/session.ts` + a SQL migration). Tiers are asserted with core's real `tier()` / `triage()` and `DEFAULT_POLICY`. Fresh copy on each access. |

## Example

```ts
import type { Connection } from "@merge-safely/core";
import {
  fakeProvider, fakeSource, fakeWorkspace, fixedClock, memoryReporter, sampleFixtures, scenarios, silentLogger,
} from "@merge-safely/testkit";

const fixture = sampleFixtures.authMigration;
const source = fakeSource(fixture);
const workspace = fakeWorkspace({ baseFiles: fixture.baseFiles, files: fixture.headFiles }); // base + head commits, per seat
const provider = fakeProvider({ script: scenarios.oneBlocker("security") });
const reporter = memoryReporter();

// ... build your gate / orchestrator with these ports, a fixedClock() and silentLogger(), then:
const conn: Connection = { id: "fake", provider: "fake", kind: "api-key", createdAt: "", secret: { kind: "api-key", apiKey: "x" } };
const runner = provider.createRunner(conn, (await provider.models(conn))[0]!, { onUsage: (d) => ledger.push(d) });
const ws = await workspace.acquire(fixture.change, { seatId: "hunter:security:1" });
const run = await runner.run(seat, input, ws);
await ws.dispose();

expect(run.output?.verdict).toBe("block");
expect(provider.calls).toHaveLength(1);
expect(workspace.active).toBe(0);
```

## Scripts

A script is `(seat, input) => ReviewerOutput | JudgeOutput | Partial<ReviewerRun> | Error` (or a promise of one):

- `ReviewerOutput` / `JudgeOutput`: status `ok`, default audit (5 substantive calls, 3 files read, 1000/200 tokens).
- `Partial<ReviewerRun>`: merged over the defaults (`audit` field by field), e.g. `{ status: "schema-invalid", output: null }`.
- `Error` (returned or thrown): status `error`, no work, no spend.

`usd` is computed from `model.pricing` (0 for `zeroCost`, `0.01` when the model has no pricing) unless the run sets
`audit.costUsd`. Usage is streamed in `usageChunks` deltas (default 2) that sum exactly to the totals.

Like the real runners:
- `delayMs` (a number, or `(seat, input) => number`) is real latency that races `seat.budget.deadlineMs`. Losing the
  race gives `timeout` with usage for the part that ran.
- A caller abort gives `error` ("run aborted by caller"). If the signal was already aborted, there is no work and no
  usage; mid-run there is partial usage.
- A run whose cost exceeds `seat.budget.maxUsd` gives `budget-exceeded` with null output.
- Judge runs carry `judgeOutput` (null on failure) and never `output`; hunter runs never carry `judgeOutput`. Output of
  the wrong role is `schema-invalid`.
- `onToolCall` fires once per `audit.totalCalls`: `read_file` for each file read, `search` up to `substantiveCalls`,
  then `list_dir`.
- `insufficient-work` is never emitted. That scenario returns `ok` with a weak audit (0 substantive calls, no files
  read) so core `attest()` does the downgrade, as it would in production.

`scriptedRuns({ hunters, judges })` keys are matched by seat id, then persona, then lens, then `"*"`. Unmatched
hunters pass; unmatched judges confirm every candidate.

```ts
scriptedRuns({
  hunters: { security: "block", "hunter:perf:2": "timeout", "*": "pass" },
  judges: { "*": "refute" },
});
```

`fakeWorkspace` does not make the checkout read-only; it is for tests, not an isolation boundary.
