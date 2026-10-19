# @merge-safely/testkit

Fakes for building and testing pipelines on `@merge-safely/core`. Depends only on core. No network.

| Fake | Port | What it gives you |
|---|---|---|
| `fakeProvider(opts)` | `ModelProvider` | Scriptable runner; records `calls`, streams `onUsage`, default audits pass attestation. |
| `scriptedRuns(spec)`, `scenarios.*` | `Script` | Per-seat behaviours: pass, block, confirm, refute, downgrade, timeout, error, insufficient-work, budget-exceeded. |
| `fakeSource(fixture)` | `SourceProvider` | In-memory change, diff, deltas, untrusted context; records `calls`; throws when `headSha` moved. |
| `fakeWorkspace(opts?)` | `Workspace` | A temp dir per acquire, optionally populated and `git init`-ed with one commit; tracks `acquired` / `disposed` / `active`. |
| `memoryReporter()`, `memoryEscalation()`, `memoryMetrics()`, `memoryTrust(map)` | Reporter, Escalation, Metrics, TrustProvider | Collect everything for assertions. |
| `fixedClock(iso)`, `silentLogger()` | Clock, Logger | Deterministic time; a logger that keeps entries and prints nothing. |
| `makeChange`, `makeFile`, `diffFromFiles`, `parseUnifiedDiff`, `fakeSha` | | Build fixtures; `diffFromFiles` emits a real unified diff (it applies with `git apply`) and fills `ChangedFile.patch`. |
| `sampleFixtures` | | `docsOnly` (tier 0), `smallLogic` (tier 1), `authMigration` (tier 3: `src/auth/session.ts` + a SQL migration). Fresh copy on each access. |

## Example

```ts
import type { Connection } from "@merge-safely/core";
import {
  fakeProvider, fakeSource, fakeWorkspace, fixedClock, memoryReporter, sampleFixtures, scenarios, silentLogger,
} from "@merge-safely/testkit";

const fixture = sampleFixtures.authMigration;
const source = fakeSource(fixture);
const workspace = fakeWorkspace({ files: fixture.headFiles }); // real files + one git commit, per seat
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

`scriptedRuns({ hunters, judges })` keys are matched by seat id, then persona, then lens, then `"*"`. Unmatched
hunters pass; unmatched judges confirm every candidate.

```ts
scriptedRuns({
  hunters: { security: "block", "hunter:perf:2": "timeout", "*": "pass" },
  judges: { "*": "refute" },
});
```

`fakeWorkspace` does not make the checkout read-only; it is for tests, not an isolation boundary.
