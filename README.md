# Merge Safely

Merge Safely is an adversarial, risk-tiered, model-agnostic AI code review gate for GitHub pull requests. It reviews every PR with a panel of AI reviewers sized to the risk of the change, makes them show their work, and publishes a verdict that is bound to one head commit. Merge bots and branch rules gate on that verdict. You bring your own model credentials and pay your own model bill. Apache-2.0, no telemetry.

It works regardless of what wrote the code: Claude Code, Cursor, Codex, any other agent, or a human.

## The problem

Most review failures that reach production are not "too few people read the diff". They are one of two things:

- **Tiering failures.** A risky change got the same light review as a typo fix. A 35-file UI redesign auto-merges with nobody looking. A backfill that locks production tables goes through because it was "just a script". A shared layout rebuild silently drops props across a hundred routes. A feature flag is removed in code but never created in production.
- **Stale-approval failures.** A PR is approved, then more commits are pushed, and it merges on the old approval. A feature enabled for every user lands in a commit nobody reviewed.

Merge Safely addresses both directly:

- **The change sets the tier, not the author.** Risk is computed from paths, size, module spread and feature-flag removals. Touching a critical path (migrations, auth, payments, CI workflows, agent config and so on) forces the highest tier. Author trust decides only who may bypass escalation and where escalations go.
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

1. **Intake.** Normalise the PR. Title, body, comments and commit messages are untrusted and only reach prompts inside delimited data blocks. Secret-shaped strings are redacted (`runner.redactSecrets`).
2. **Tier.** Score 0 to 100 from lines changed, files changed, module spread, critical-path hits and feature-flag removals. Level 0 trivial, 1 standard, 2 elevated, 3 critical. A critical-path hit, a removed feature-flag read or a truncated file list forces tier 3.
3. **Triage.** Tier 0 only. Docs-only, assets-only and lockfile-only changes, and changes of at most 30 lines in at most 3 files, are auto-passed deterministically, with no model call.
4. **Seat.** Choose lenses (questions to answer), seat count and models per tier. With more than one connection, hunters are spread across connections and judges prefer a different one.
5. **Budget.** Estimate the panel cost against five ceilings. Over budget: step down the downgrade ladder, or refuse with the exact ceiling and policy key to raise.
6. **Run.** Each hunter runs in a fresh context against a disposable checkout of the head SHA, with read-only tools.
7. **Proof of work.** The runner records what each reviewer actually read and ran. A pass with too little work does not count.
8. **Judges.** Judges see the hunters' findings and the diff and vote confirm, refute or downgrade on each one. Style-only classes are dropped. At tier 3, findings the judges split on get a second judge round.
9. **Aggregate.** Deduplicate, rank by severity, count quorum. A surviving blocker, or a hunter block upheld by the judges, blocks. Enough valid passes pass. Anything else is pending.
10. **Verdict.** Written compare-and-set to the verdict store, keyed by head SHA. A machine pass cannot replace a stored machine block with open findings for the same SHA (the result is reported as contested), and a run that could not decide never replaces a decided verdict.
11. **Report.** Check run, PR review and inline comments, with the digest and a cost line.
12. **Rounds.** On a new push, reviewers get the delta diff and the known findings, check whether each was addressed, and never repeat one. A known blocker stays until a later round shows it addressed or a human passes the commit. After `rounds.max` reviewed commits, when a review cannot decide, or when a non-trusted author's tier 3 change blocks, a human gets a pre-digested escalation.

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
concurrency:
  group: merge-safely-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: simonstaton/merge-safely@v0
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

That is enough. No `actions/checkout` step is needed: the Action clones the head SHA itself. With no `.merge-safely.yml` on the base branch, the conservative defaults apply. The check run is named `merge-safely/verdict`. See [docs/quickstart-action.md](docs/quickstart-action.md).

## Quickstart: CLI

The packages are not on npm yet, so install the CLI from a checkout (Node 20 or later):

```bash
git clone https://github.com/simonstaton/merge-safely.git && cd merge-safely
npm ci && npm run build
npm link -w packages/cli              # puts `merge-safely` on your PATH

export ANTHROPIC_API_KEY=sk-ant-...
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY
cd ~/src/your-repo
merge-safely estimate --local         # tier, seats, models and estimated cost; no model is called
merge-safely run --local              # review your working tree against the default branch
```

`run --local` is the "review while you write" loop: the same lenses, policy and connections as the PR gate, printed to your terminal before you open a PR. Nothing is stored or posted. See [docs/quickstart-cli.md](docs/quickstart-cli.md).

### Verified end to end

The local loop has been run for real: a 12-line change with a planted bug, reviewed with `merge-safely run --local` by two Claude Sonnet hunters and one Claude Opus judge through the Claude Code CLI runner (`connect anthropic --runner cli`), with triage turned off so a change that small gets a panel. The verdict was `BLOCK` with the correct finding, in 26 seconds.

## What you read: the digest

The digest is what a human reads instead of the diff. It appears in the check run summary, the PR review body and escalation messages.

```
Verdict: BLOCK (tier 3, round 2 of 3)
commit 3f2c9e1
Why tier 3: size: 182 lines changed across 6 files in 3 modules (score 39); touches critical path **/jobs/**/backfill* (services/api/src/jobs/backfillJob.ts); tier 3 forced by critical path hit (score alone would be tier 1)
Quorum: 2 required, 4 passed, 2 blocked, 1 invalid

Blockers (1)
  [lock-risk] Backfill scans a large table without batching — services/api/src/jobs/backfillJob.ts:41 (#f3a9c1)
     The UPDATE runs over every row of user_stats in one transaction and holds row locks until it commits.
     Evidence: ran EXPLAIN on the raw query: seq scan, no LIMIT, inside one transaction.
     Suggested: batch by id ranges of 1000 with a sleep, commit per batch.

Important (2) … Nits (3) … Pre-existing (1)

Addressed since round 1: 4 of 6 findings. Not addressed: #f3a9c1, #c17e02.
Reviewer effort: 41 files read, 12 commands.
Cost: $1.84 · 212.4k tokens in / 18.9k out · 9 seats · 2m 10s
```

## Wiring it to your merge process

Merge Safely never merges. It publishes a check run per head SHA with pending, success and failure states. (With a personal access token the CLI writes a commit status of the same name instead, because only App and Actions tokens can write check runs.)

- **GitHub rulesets or branch protection:** require the `merge-safely/verdict` check and pin its source app. Express trusted-team bypass with bypass actors.
- **Mergify:** add `check-success = merge-safely/verdict` to your queue conditions.
- **GitHub merge queue:** the same required check; add `merge_group` to the Action's triggers.
- **Anything else:** read the verdict JSON (the Action's `verdict-json` output, `merge-safely --json explain`, or the App's API).

Because the check is bound to the head SHA, a push after a green verdict flips it back to pending. That closes the stale-approval hole without any extra rule. See [docs/merge-bots.md](docs/merge-bots.md) and [examples/](examples/).

## What it never does

- **Merge.** It emits a signal. Your merge bot or ruleset decides.
- **Write code.** Reviewers have read-only tools. No write, no package install, no network beyond the model API. The one exception is a command you list in `runner.allowedCommands` (empty by default), which runs the PR's own code; see [docs/security.md](docs/security.md#what-allowedcommands-exposes).
- **Proxy tokens or hold a model budget.** Your keys go straight from your runner to your model provider. There is no hosted inference and no markup.
- **Phone home.** No telemetry, no analytics, no update checks.

## Packages

npm workspaces monorepo. Each `packages/<name>` publishes `@merge-safely/<name>`.

| Package | What it is |
|---|---|
| `core` | Domain types, ports, policy schema, pure pipeline stages, budgets, and the `createGate` orchestrator. Zero I/O. |
| `lenses` | The eight shipped lenses, shared rubric, personas, prompt builders, untrusted-text delimiting. |
| `registry` | Model registry data and pricing, including the pessimistic fallback rate. |
| `providers` | Connection kinds, connections file, envelope encryption, provider registry, catalog, model resolution. |
| `provider-anthropic` | Messages API runner and Claude Code CLI runner. |
| `provider-openai` | OpenAI Responses and Chat Completions runners, including OpenAI-compatible endpoints. |
| `provider-gemini` | Gemini Developer API runner. |
| `provider-compatible` | OpenAI-compatible, Anthropic-compatible, Ollama and LM Studio presets, and `allProviders()`. |
| `tools` | The shared read-only tool set, runner-observed audit and shared agentic loop. |
| `github` | Source provider, check run, commit status and PR review reporters, check-run-backed store, trust providers, webhook verifier, App auth. |
| `workspace-local` | Disposable git worktrees from a bare mirror, and the working-tree workspace for `--local`. |
| `store-memory`, `store-fs`, `store-sqlite` | Verdict stores and cost ledgers, with shared contract suites. |
| `escalation-slack` | Slack incoming-webhook escalation and reporter. |
| `cli` | The `merge-safely` command. |
| `action` | The GitHub Action. |
| `app` | The self-hosted GitHub App service. |
| `evals` | Eval suite format, runner, reports and a starter incident suite. |
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

Version 0.1, pre-release. Interfaces may change before 1.0. The packages are not yet published to npm.

In 0.1:

- GitHub Action, CLI (`connect`, `connections`, `run`, `run --local`, `estimate`, `explain`, `verdict`, `policy lint`/`init`, `eval`) and a self-hosted GitHub App.
- Anthropic (Messages API and Claude Code CLI runners), OpenAI (Responses and Chat Completions), Gemini, OpenAI-compatible and Anthropic-compatible endpoints, Ollama and LM Studio.
- Tiering, triage, panels with judges, proof of work, rounds, five budget ceilings with the downgrade ladder.
- Check-run-backed, filesystem, SQLite and in-memory verdict stores and cost ledgers.
- Slack escalation and an eval runner with a starter incident suite.

The only workspace is a local git checkout, so isolation is whatever your runner gives you (see [docs/security.md](docs/security.md)). There are no plans to run a hosted instance.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
