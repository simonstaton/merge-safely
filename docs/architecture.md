# Architecture

Merge Safely is hexagonal: one pure core, a set of ports, and adapters that implement them. The decision logic has zero I/O. Everything that touches a VCS, a model, a filesystem or a network is a port with swappable adapters. The Action, the CLI and the App are thin entry points over the same pipeline.

```
                 ┌─────────────────────────────────────────────┐
  SourceProvider │                  core                       │  Reporter
  (GitHub,      ─►  intake → tier → rounds plan → triage →      ├─► (check run, commit status,
   local git)    │  seat → budget → run* → proof of work →      │    PR review, Slack)
                 │  judges → aggregate → verdict → report →     │
                 │  escalate                                   │
  ModelProvider ─►                                             ├─► VerdictStore
  (Anthropic,    │  * run is the only stage that calls a port  │    (memory, fs, sqlite,
   OpenAI,       │    during execution; everything else is     │     check run)
   Gemini,       │    pure given its inputs                    │
   compatible)   │                                             ├─► CostLedger
                 │                                             │
  Workspace     ─►                                             ├─► Escalation (Slack)
  (git worktree, │                                             │
   working tree) │                                             ├─► Metrics
                 └─────────────────────────────────────────────┘
                                    ▲
                              TrustProvider
                       (GitHub teams, allowlist)
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
| `Logger`, `Clock` | Logging and time, injected so the core stays deterministic. |

## Packages

| Package | Role | Depends on (`@merge-safely/*`) |
|---|---|---|
| `@merge-safely/core` | Domain types, ports, policy schema, pure stages, budgets, seating, `createGate`. Zero I/O, no vendor SDKs. | – |
| `@merge-safely/lenses` | Shipped lenses, rubric, personas, prompt builders, untrusted delimiting. Pure. | core |
| `@merge-safely/registry` | Model registry data, pricing, pessimistic fallback, cheaper-model lookup. Pure. | core |
| `@merge-safely/providers` | Connection kinds, connections file, envelope encryption, provider registry, catalog, model resolution. No vendor SDKs. | core |
| `@merge-safely/tools` | Shared read-only tool set, runner-observed audit, vendor tool-shape converters, shared agentic loop. | core, registry |
| `@merge-safely/provider-anthropic` | Messages API runner, Claude Code CLI runner. | core, registry, providers, tools |
| `@merge-safely/provider-openai` | Responses and Chat Completions runners, including OpenAI-compatible endpoints. | core, registry, tools |
| `@merge-safely/provider-gemini` | Gemini Developer API runner. | core, registry, tools |
| `@merge-safely/provider-compatible` | OpenAI-compatible, Anthropic-compatible, Ollama and LM Studio presets; `allProviders()`. | core, registry, providers, tools, provider-anthropic, provider-openai, provider-gemini |
| `@merge-safely/github` | Source provider, check run, commit status and PR review reporters, check-run-backed store, trust providers, webhook verifier, App auth. | core |
| `@merge-safely/workspace-local` | `localWorkspace` (bare mirror plus a worktree per seat) and `currentTreeWorkspace` (the working tree, for `--local`). | core |
| `@merge-safely/store-memory` | In-memory store and ledger, plus the contract test suites every store runs. | core |
| `@merge-safely/store-fs` | Filesystem store and ledger. No database, no native modules. | core |
| `@merge-safely/store-sqlite` | SQLite store and ledger (WAL, compaction). Used by the App and by `--store sqlite`. | core |
| `@merge-safely/escalation-slack` | Slack incoming-webhook escalation and reporter. | core |
| `@merge-safely/evals` | Eval suite format, runner, reports, circuit breakers, starter suite. | core, github, lenses, store-memory, workspace-local |
| `@merge-safely/cli` | The `merge-safely` binary, and the gate wiring the Action reuses. | every adapter above, plus evals |
| `@merge-safely/action` | The GitHub Action entry point. | core, cli |
| `@merge-safely/app` | Self-hosted GitHub App: webhooks, durable queue, setup page, encrypted connections, alerts. | core, lenses, registry, providers, tools, workspace-local, the four provider packages, github, store-sqlite, escalation-slack |
| `@merge-safely/testkit` | Fake providers, sources, workspaces and fixtures. | core |

Rules:

- `core` never imports an adapter or a vendor SDK.
- Packages import each other by package name, never by relative path across packages.
- Model knowledge (pricing, tiers, catalogs) is injected into core functions, because core cannot depend on the registry.

## Pipeline stages

Each stage is an exported function of `@merge-safely/core`. Every stage except running a seat is pure given its inputs. `createGate` runs them in this order (see [`packages/core/src/orchestrator/gate.ts`](../packages/core/src/orchestrator/gate.ts)):

| Stage | Function | What it does |
|---|---|---|
| Intake | `intake()` | Normalise the change; copy untrusted text out; redact secret shapes. |
| Tier | `tier()` | Composite score; critical paths, flag removals and truncated file lists force tier 3. |
| Rounds plan | `planRound()` | Round number, open findings from earlier verdicts, delta-only or full, round cap. |
| Triage | `triage()` | Deterministic auto-pass for tier 0 docs, assets, lockfiles and small diffs. |
| Seat | `seat()` | Lenses, seat count, models, decorrelation, fallback. Throws `SeatingError` with a fix hint on a misconfigured policy. |
| Budget | `evaluateCeilings()`, `admit()`, `downgradeLadder()` | Five ceilings, then the downgrade ladder or a refusal. |
| Run | `ModelRunner.run` | One run per seat, hunters concurrently (`concurrency`, default 4; the CLI uses 2). |
| Proof of work | `attest()` | Reject passes and judge votes with too little runner-observed work. |
| Judges | `applyJudgeVotes()` | Votes per finding; drop style classes; optional second round on split votes. |
| Rounds reconcile | `reconcileRounds()` | Which known findings were addressed; the rest are carried. |
| Aggregate | `aggregate()`, `dedupeFindings()`, `rankFindings()` | Fingerprint, dedupe, rank, quorum, decision. |
| Verdict | `canAcceptVerdict()` + the store's compare-and-set | No-downgrade guards; contested and pending rules. |
| Report | `renderDigest()` | Digest and cost line to every reporter. |
| Escalate | the `Escalation` port | Once per commit, after the verdict is stored. |

Every port call is time-bounded (`DEFAULT_PORT_TIMEOUTS`: 120 s for the source and workspace, 30 s for the store, reporters, escalation, trust and ledger reads, 5 s per ledger append). A failing reporter, metrics sink, ledger append or escalation never fails a review. Once the change is known, any other failure reports an `error` event and rejects with a `GateError` whose message is secret-scrubbed.

`review()` loads the change through the `SourceProvider`, pins the head SHA (`head-moved` if it changed) and persists the verdict. `reviewChange()` takes a change you already hold and persists only with `{ persist: true }`; that is what `run --local` and the eval runner use. `estimate()` runs tier, triage, round plan, seating and admission with no model call. `explain()` reads the stored verdict and history. `recordHumanVerdict()` stores a SHA-bound human verdict.

## Composing your own pipeline

The orchestrator takes ports and a policy and returns a gate. [examples/programmatic/gate.ts](../examples/programmatic/gate.ts) is a complete, type-checked program that reviews one pull request with the same wiring as `merge-safely run --repo … --pr … --report github --store checkrun`. Its core:

```ts
const registry = createProviderRegistry(allProviders());
const catalog = catalogLookup(await buildCatalog(registry, connections));
const octokit = octokitFromToken(token);

const gate = createGate({
  source: githubSource({ octokit }),
  workspace: localWorkspace({ cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`, token }),
  providers: (conn) => registry.forConnection(conn),
  connections,
  catalog,
  store: checkRunStore({ octokit, policy }),
  ledger,
  reporters: [checkRunReporter({ octokit, policy }), prReviewReporter({ octokit, policy })],
  trust: trustFromPolicy(policy, octokit),
  policy,
  tools: createReadOnlyTools,
  prompts,   // buildHunterPrompt / buildJudgePrompt from @merge-safely/lenses
  pricing,   // withPricing / priceUsage / cheaperModel from @merge-safely/registry
  installationId: `${repo.owner}/${repo.name}`,
});

const result = await gate.review({ repo, number });
console.log(result.digest.text);
```

Core takes `prompts` and `pricing` as injected functions because it depends on neither the lenses nor the registry; the example shows both in full. Check it compiles with `npx tsc --noEmit -p examples/programmatic/tsconfig.json`.

You can also call the stages directly, for example to compute a tier and seating for a dashboard without running any model, or plug in your own `Workspace` that runs each seat in a container. `@merge-safely/testkit` has fakes for every port.

## Writing an adapter

- **A provider.** Implement `ModelProvider` and a `ModelRunner`. Use the shared `ToolExecutor` from `RunnerOptions.tools` so proof-of-work semantics match every other provider. Stream usage through `onUsage`. Never throw from `validate` or `run`: return `ok: false` or a `ReviewerRun` with a status. Classify budget stops as `budget-exceeded`. Scrub secrets from every string you return.
- **A store.** Implement `VerdictStore` and `CostLedger`, then run the contract suites from `@merge-safely/store-memory` against your implementation. Compare-and-set must be atomic, and repository keys compare case-insensitively.
- **A lens.** See [lenses.md](lenses.md#writing-a-third-party-lens).
- **A reporter or escalation.** Implement `Reporter` or `Escalation`. Treat every string from the verdict as untrusted when rendering. A reporter must not throw in a way that breaks the review.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
