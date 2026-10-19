# Merge Safely

Merge Safely is an adversarial, risk-tiered, model-agnostic AI code review gate for GitHub pull requests. It reviews every PR with a panel of AI reviewers sized to the risk of the change, makes them show their work, and publishes a verdict that is bound to one head commit. Merge bots and branch rules gate on that verdict. You bring your own model credentials and pay your own model bill. Apache-2.0, no telemetry.

It works regardless of what wrote the code: Claude Code, Cursor, Codex, any other agent, or a human.

## The problem

Most review failures that reach production are not "too few people read the diff". They are one of two things:

- **Tiering failures.** A risky change got the same light review as a typo fix. A 35-file UI redesign auto-merges with nobody looking. A backfill that locks production tables goes through because it was "just a script". A shared layout rebuild silently drops props across a hundred routes. A feature flag is removed in code but never created in production.
- **Stale-approval failures.** A PR is approved, then more commits are pushed, and it merges on the old approval. A feature enabled for every user lands in a commit nobody reviewed.

Merge Safely addresses both directly:

- **The change sets the tier, not the author.** Risk is computed from paths, size, module spread and flag removals. Touching a critical path (migrations, auth, payments, CI workflows, agent config and so on) forces the highest tier. Author trust decides only who may bypass and where escalations go.
- **Verdicts are facts about a commit.** A verdict is bound to a head SHA. A new push invalidates it and the check goes back to pending. There is no such thing as approving a PR.

## How it works

```
 PR event / local tree
        │
        ▼
 intake ─► tier ─► triage ──(tier 0, docs/assets/lockfile/tiny)──► auto-pass
                     │
                     ▼
                   seat ─► budget check ─► run (hunters, in parallel, read-only)
                                                │
                                                ▼
                                    proof of work (runner-attested)
                                                │
                                                ▼
                                   judges vote on each finding
                                                │
                                                ▼
                              aggregate ─► verdict (SHA-bound) ─► report
                                                                    │
                    new push: diff-only re-review, known findings ◄─┘
                    after max rounds: escalate to a human
```

1. **Intake.** Normalise the PR. Title, body, comments and commit messages are untrusted and only reach prompts inside delimited data blocks.
2. **Tier.** Score 0 to 100 from lines changed, files, module spread and critical-path hits. Level 0 trivial, 1 standard, 2 elevated, 3 critical. A critical-path hit or a removed feature-flag read forces tier 3.
3. **Triage.** Tier 0 only. Docs-only, assets-only, lockfile-only or tiny non-critical diffs are auto-passed deterministically, with no model call.
4. **Seat.** Choose lenses (questions to answer), seat count and models per tier. Models are decorrelated across your connected providers.
5. **Budget.** Estimate the panel cost against your ceilings. Over budget: step down the downgrade ladder, or block with the exact ceiling to raise.
6. **Run.** Each hunter runs in a fresh context against a disposable checkout of the head SHA, with read-only tools.
7. **Proof of work.** The runner records what each reviewer actually read and ran. A pass with too little work does not count.
8. **Judges.** Judges see the hunters' findings and the diff and vote confirm, refute or downgrade on each one. Style-only findings are dropped.
9. **Aggregate.** Deduplicate, rank by severity, compute quorum. One surviving blocker blocks.
10. **Verdict.** Written compare-and-set to the verdict store. A later pass cannot overwrite an unresolved block for the same SHA.
11. **Report.** Check run, PR review and inline comments, with the digest and a cost line.
12. **Rounds.** On a new push, reviewers get the delta diff and the known findings, check whether each was addressed, and never repeat one. After the round cap, or at tier 3 for non-trusted authors, a human gets a pre-digested queue.

## Quickstart: GitHub Action

Add one repository secret, `ANTHROPIC_API_KEY`, then add this workflow:

```yaml
# .github/workflows/merge-safely.yml
name: merge-safely
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  checks: write
  pull-requests: write
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: simonstaton/merge-safely@v0
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

That is enough. With no `.merge-safely.yml` in the repo, the conservative defaults apply. The check run is named `merge-safely/verdict`. See [docs/quickstart-action.md](docs/quickstart-action.md).

## Quickstart: CLI

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY
npx merge-safely estimate --local     # tier, seats, models and estimated cost; nothing runs
npx merge-safely run --local          # review your working tree against the base branch
```

`run --local` is the "review while you write" loop: the same lenses and connections as the PR gate, printed to your terminal before you open a PR. See [docs/quickstart-cli.md](docs/quickstart-cli.md).

## What you read: the digest

The digest is what a human reads instead of the diff. It appears in the check run summary, the PR review body and escalation messages.

```
Verdict: BLOCK (tier 3, round 2 of 3)                                 cost $1.84 · 3 seats · 2m 10s
Why tier 3: touches packages/db/queries/*Raw.ts and services/api/src/jobs/** (critical paths)
Quorum: 2 required, 1 passed, 2 blocked

Blockers (1)
  [lock-risk] Backfill scans a large table without batching — services/api/src/jobs/backfillJob.ts:41
     Evidence: ran EXPLAIN on the raw query; seq scan, no LIMIT, inside one transaction.
     Suggested: batch by id ranges of 1000 with a sleep, commit per batch.

Important (2) … Nits (3) … Pre-existing (1)

Addressed since round 1: 4 of 6 findings. Not addressed: #f3a9, #c17e.
Reviewer effort: 41 files read, 12 commands.
```

## Wiring it to your merge process

Merge Safely never merges. It publishes a check run per head SHA with pending, success and failure states.

- **GitHub rulesets or branch protection:** require the `merge-safely/verdict` check. Express trusted-team bypass with bypass actors.
- **Mergify:** add `check-success = merge-safely/verdict` to your queue conditions.
- **GitHub merge queue:** the same required check.
- **Anything else:** read the verdict JSON.

Because the check is bound to the head SHA, a push after a green verdict flips it back to pending. That closes the stale-approval hole without any extra rule. See [docs/merge-bots.md](docs/merge-bots.md) and [examples/](examples/).

## What it never does

- **Merge.** It emits a signal. Your merge bot or ruleset decides.
- **Write code.** Reviewers have read-only tools. No write, no package install, no network beyond the model API.
- **Proxy tokens or hold a model budget.** Your keys go straight from your runner to your model provider. There is no hosted inference and no markup.
- **Phone home.** No telemetry, no analytics, no update checks.

## Packages

npm workspaces monorepo. Each `packages/<name>` publishes `@merge-safely/<name>`.

| Package | What it is |
|---|---|
| `core` | Domain types, ports, policy schema, pure pipeline stages, budgets, orchestrator. Zero I/O. |
| `lenses` | The eight shipped lenses, shared rubric, personas, prompt builders, untrusted-text delimiting. |
| `registry` | Model registry data and pricing, including the pessimistic fallback. |
| `providers` | Connection kinds, connections file, envelope encryption, provider registry, model resolution. |
| `provider-anthropic` | Messages API runner and Claude Code CLI runner. |
| `provider-openai` | OpenAI Responses and Chat Completions runners, including OpenAI-compatible endpoints. |
| `provider-gemini` | Gemini Developer API runner. |
| `provider-compatible` | OpenAI-compatible and Anthropic-compatible base-URL runners. |
| `tools` | The shared read-only tool set and runner-observed audit. |
| `github` | Source provider, check run and PR review reporters, trust provider, webhook verifier, App auth, check-run-backed store. |
| `workspace-local` | Local git checkout workspace. |
| `store-memory`, `store-fs`, `store-sqlite` | Verdict stores and cost ledgers. |
| `escalation-slack` | Slack incoming-webhook escalation and reporter. |
| `cli` | The `merge-safely` command. |
| `action` | The GitHub Action. |
| `app` | The self-hosted GitHub App service. |
| `evals` | Eval suite format, runner and reports. |
| `testkit` | Fakes and fixtures for testing pipelines. |

See [docs/architecture.md](docs/architecture.md).

## Documentation

- [Quickstart: GitHub Action](docs/quickstart-action.md)
- [Quickstart: CLI](docs/quickstart-cli.md)
- [Quickstart: self-hosted GitHub App](docs/quickstart-app.md)
- [Policy reference](docs/policy.md)
- [Connections](docs/connections.md)
- [Budgets and cost](docs/budgets.md)
- [Lenses and personas](docs/lenses.md)
- [Merge bots and required checks](docs/merge-bots.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)
- [Design document](docs/design.md)

## Status

Version 0.1, pre-release. Interfaces may change before 1.0.

In 0.1:

- GitHub Action and CLI (`connect`, `run`, `run --local`, `estimate`, `explain`, `policy lint`).
- Anthropic (Messages API and Claude Code CLI runners), OpenAI (API runner), Gemini, and OpenAI-compatible and Anthropic-compatible endpoints.
- Tiering, triage, panel with judges, proof of work, budgets with the downgrade ladder.
- Check-run-backed, filesystem, SQLite and in-memory stores.
- Slack escalation.
- A self-hosted GitHub App.

Not yet:

- Cloud providers (Bedrock, Vertex, Azure OpenAI) and the Codex CLI runner.
- Container and remote-sandbox workspaces. Today the workspace is a local checkout, so isolation is whatever your runner gives you.
- Postgres store, OpenTelemetry metrics, GitLab.
- A hosted instance. There are no plans to run one.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
