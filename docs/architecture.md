# Architecture

Merge Safely is hexagonal: one pure core, a set of ports, and adapters that implement them. The decision logic has zero I/O. Everything that touches a VCS, a model, a filesystem or a network is a port with swappable adapters. The Action, the CLI and the App are thin entry points over the same pipeline.

```
                 ┌─────────────────────────────────────────────┐
  SourceProvider │                  core                       │  Reporter
  (GitHub,      ─►  intake → tier → triage → seat → budget →    ├─► (check run, PR review,
   local git)    │  run* → proof of work → judges → aggregate → │    Slack, stdout, JSON)
                 │  verdict → report → rounds                  │
  ModelProvider ─►                                             ├─► VerdictStore
  (Anthropic,    │  * run is the only stage that calls a port  │    (memory, fs, sqlite,
   OpenAI,       │    during execution; everything else is     │     check run)
   Gemini,       │    pure given its inputs                    │
   compatible)   │                                             ├─► CostLedger
                 │                                             │
  Workspace     ─►                                             ├─► Escalation (Slack)
  (local         │                                             │
   checkout)     │                                             ├─► Metrics
                 └─────────────────────────────────────────────┘
                                    ▲
                              TrustProvider
                  (GitHub teams, allowlist, CODEOWNERS)
```

## Ports

Defined in [`packages/core/src/ports.ts`](../packages/core/src/ports.ts). Domain types are in [`packages/core/src/types.ts`](../packages/core/src/types.ts).

| Port | Responsibility |
|---|---|
| `SourceProvider` | Fetch the change, its diff (full or delta since a SHA, pinned to a head SHA) and untrusted context (commit messages, comments). |
| `Workspace` | Provide a disposable, read-only checkout of the head SHA, isolated per seat. |
| `ModelProvider` | One model backend: which connection kinds it accepts, `validate`, `models`, and `createRunner`. |
| `ModelRunner` | Run one seat. Enforce the output schema, read-only tools and the budget, and produce the audit from its own observation. |
| `ToolExecutor` | The shared read-only tool set bound to one workspace. The runner executes tools; the model never does. |
| `VerdictStore` | Get and compare-and-set SHA-bound verdicts. |
| `CostLedger` | Append streamed cost deltas; sum by change, rolling window and all-time. |
| `Reporter` | Render `pending`, `verdict`, `escalated`, `budget-blocked` and `error` events. |
| `TrustProvider` | Classify an author as trusted, standard or blocked. Used only for bypass and escalation routing. Never changes the tier. |
| `Escalation` | Hand a verdict and digest to a human; optionally resolve to a SHA-bound human verdict. |
| `Metrics` | Emit metric events. |

## Packages

| Package | Role | Depends on |
|---|---|---|
| `@merge-safely/core` | Domain types, ports, policy schema, pure stages, budgets, orchestrator. Zero I/O, no vendor SDKs. | – |
| `@merge-safely/lenses` | Shipped lenses, rubric, personas, prompt builders, untrusted delimiting. Pure. | core |
| `@merge-safely/registry` | Model registry data and pricing. Pure. | core |
| `@merge-safely/providers` | Connection kinds, connections file, envelope encryption, provider registry, catalog, model resolution. No vendor SDKs. | core, registry |
| `@merge-safely/tools` | Shared read-only tool implementation and runner-observed audit. | core |
| `@merge-safely/provider-anthropic` | Messages API runner, Claude Code CLI runner. | core, registry, providers, tools |
| `@merge-safely/provider-openai` | Responses and Chat Completions runners, including OpenAI-compatible endpoints. | core, registry, providers, tools |
| `@merge-safely/provider-gemini` | Gemini Developer API runner. | core, registry, providers, tools |
| `@merge-safely/provider-compatible` | OpenAI-compatible and Anthropic-compatible base-URL runners. | core, registry, providers, tools, provider-anthropic, provider-openai |
| `@merge-safely/github` | Source provider, check run and PR review reporters, team trust, webhook verifier, App auth, check-run-backed store. | core |
| `@merge-safely/workspace-local` | Local git checkout workspace. | core |
| `@merge-safely/store-memory` | In-memory store and ledger, plus the contract test suites every store runs. | core |
| `@merge-safely/store-fs` | Filesystem store and ledger. No database, no native modules. | core |
| `@merge-safely/store-sqlite` | SQLite store and ledger (WAL, compaction). Default for the CLI and App. | core |
| `@merge-safely/escalation-slack` | Slack incoming-webhook escalation and reporter. | core |
| `@merge-safely/cli` | The `merge-safely` binary. | everything except app, action, evals, testkit |
| `@merge-safely/action` | The GitHub Action entry point. | core, cli |
| `@merge-safely/app` | Self-hosted GitHub App: webhooks, queue, setup page, encrypted connections. | the adapters it runs, store-sqlite |
| `@merge-safely/evals` | Eval suite format, runner and reports. | core, cli |
| `@merge-safely/testkit` | Fake providers, sources and fixtures. | core |

Rules:

- `core` never imports an adapter or a vendor SDK.
- Packages import each other by package name, never by relative path across packages.
- Model knowledge (pricing, tiers, catalogs) is injected into core functions, because core cannot depend on the registry.

## Pipeline stages

Each stage is an exported function. Every stage except `run` is pure given its inputs. See [design §4.2](design.md#42-pipeline-stages).

| Stage | In core |
|---|---|
| Intake | Normalise the change; quarantine untrusted text. |
| Tier | Composite score; critical paths and flag removals force tier 3. |
| Triage | Deterministic auto-pass for tier 0 docs, assets, lockfiles and tiny diffs. |
| Seat | `seat()`: lenses, seat count, models, decorrelation, fallback. Throws `SeatingError` with a fix hint on a misconfigured policy. |
| Budget | `admit()`, `evaluateCeilings()`, `downgradeLadder()`. |
| Run | `ModelRunner.run` per seat, concurrently. |
| Proof of work | Downgrade passes with too little runner-observed work. |
| Judges | Vote per finding; drop style classes. |
| Aggregate | Fingerprint, dedupe, rank, quorum. |
| Verdict | Compare-and-set into the store. |
| Report | Digest and cost line to every reporter. |
| Rounds | Delta diff, known findings, escalation after the cap. |

## Composing your own pipeline

The orchestrator takes ports and a policy and returns a gate. The shape below follows [design §6.4](design.md#64-programmatic) with this repository's package names. Exports from packages that are still being built (`github`, `workspace-local`, the `createGate` orchestrator) are illustrative; check each package's README for the exact names.

```ts
import { readFile } from "node:fs/promises";
import { createGate, loadPolicy } from "@merge-safely/core";
import { github } from "@merge-safely/github";
import { anthropicProvider } from "@merge-safely/provider-anthropic";
import { openaiProvider } from "@merge-safely/provider-openai";
import { createProviderRegistry, loadConnectionsFile } from "@merge-safely/providers";
import { sqliteStores } from "@merge-safely/store-sqlite";
import { slackEscalation } from "@merge-safely/escalation-slack";
import { localWorkspace } from "@merge-safely/workspace-local";
import { parse } from "yaml";

const policy = loadPolicy(parse(await readFile(".merge-safely.yml", "utf8")));
const connections = await loadConnectionsFile(); // $MERGE_SAFELY_HOME/connections.json, decrypted with MERGE_SAFELY_MASTER_KEY
const { verdicts, ledger } = sqliteStores({ path: ".merge-safely/store.db" });

const gate = createGate({
  source: github({ token: process.env.GITHUB_TOKEN }),
  providers: createProviderRegistry([anthropicProvider(), openaiProvider()]),
  connections,
  workspace: localWorkspace(),
  store: verdicts,
  ledger,
  reporters: [github.checkRun(), github.prReview()],
  escalation: slackEscalation({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
  trust: github.teams(),
  policy,
});

const verdict = await gate.review({ repo: { host: "github.com", owner: "my-org", name: "my-repo" }, number: 1234 });
```

You can also call the stages directly, for example to compute a tier and seating for a dashboard without running any model, or to plug in your own `Workspace` that runs each seat in a container.

## Writing an adapter

- **A provider.** Implement `ModelProvider` and a `ModelRunner`. Use the shared `ToolExecutor` from `RunnerOptions.tools` so proof-of-work semantics match every other provider. Stream usage through `onUsage`. Never throw from `validate` or `run`: return `ok: false` or a `ReviewerRun` with a status. Classify budget stops as `budget-exceeded`. Scrub secrets from every string you return.
- **A store.** Implement `VerdictStore` and `CostLedger`, then run the contract suites from `@merge-safely/store-memory` against your implementation.
- **A lens.** See [lenses.md](lenses.md#writing-a-third-party-lens).
- **A reporter or escalation.** Implement `Reporter` or `Escalation`. Treat every string from the verdict as untrusted when rendering. A reporter must not throw in a way that breaks the review.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
