# Merge Safely GitHub Action

The zero-infrastructure deployment of Merge Safely (design section 6.1). It reviews each pull request head with
your own model keys and publishes a commit-pinned `merge-safely/verdict` check run. Rulesets, Mergify and the merge
queue require that check. No database, no server: the verdict lives in the check run.

```yaml
- uses: simonstaton/merge-safely@v0
  with:
    connections: |
      anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `connections` | required | YAML map of connection id to connection. It has the same fields as the CLI connections file (`provider`, `apiKey` or `apiKeyEnv`, `baseUrl`, `headers`, `model`, ...). See [connections.md](../../docs/connections.md#the-actions-connections-input). `merge_group` runs do not use it. |
| `policy` | `.merge-safely.yml` | Path of the policy file in the repository. It is read from the PR's **base** branch, never from the head. A missing file means the defaults. See [Policy source](#policy-source). |
| `github-token` | `${{ github.token }}` | Reads the PR and writes the check run and the PR review. A personal token cannot write check runs. |
| `fail-on-block` | `true` | Fail the job on a `block` verdict. With `false`, only the check run carries the signal. Pending, contested, error and budget-blocked outcomes always fail the job. |
| `store` | `checkrun` | Where verdicts are kept. v0.1 supports only `checkrun`: the verdict is stored in the check run, plus a round-history comment on the PR. Use the CLI or the App for the file and SQLite stores. |
| `slack-webhook` | none | Slack incoming-webhook URL for escalations. Pass it from a secret. |
| `concurrency` | `2` | How many reviewer seats run in parallel (1 to 16). |
| `pr-number` | none | The PR to review on `workflow_dispatch`. Not allowed on any other event. |
| `head-sha` | the PR head | Pins the expected PR head (a full SHA, 40 or 64 hex characters). Verdicts are bound to the PR head, so only the current head can be reviewed. If the PR has moved, a `workflow_dispatch` run fails with an explanation. |
| `verdict-app-slugs` | `github-actions` | Comma-separated GitHub App slugs whose check runs count as verdicts when the Action reads them: merge-queue lookups and trusted `check_run` re-runs. The token's own app is always included. See [App for PRs, Action for the merge queue](#app-for-prs-action-for-the-merge-queue). |

Every secret in `connections` is masked in the job log before anything is printed, and so is any `apiKeyEnv`
value the Action resolves. Error messages never quote the input. The YAML parser runs silently, so its warnings
cannot echo a source line. Any YAML error or warning, such as an unresolved `!tag`, fails the run and reports only
the line number. Step outputs and the job summary go through the same redactor.

## Outputs

| Output | Example |
|---|---|
| `decision` | `pass`, `block`, `pending`, `contested`, `error`, `budget-blocked`; `skipped` when the event needs no review (a draft, a label change) |
| `tier` | `2` |
| `round` | `1` |
| `cost-usd` | `0.432100` (empty when unpriced) |
| `check-url` | `https://github.com/acme/app/runs/123456` |
| `verdict-json` | one-line JSON with the decision, head SHA, round, tier, findings (id, severity, class, title, file, line), quorum, cost and policy hash. Seats and audits stay in the check run. |

The job summary shows the digest, the cost line (dollars, tokens, seats, connections, downgrades) and a link to the
check run.

The job's exit code follows the CLI: 0 for pass, 1 for block, 2 for pending, contested, error or a configuration
problem, and 3 for budget-blocked. GitHub treats any non-zero code as a failure.

## Permissions

```yaml
permissions:
  checks: write          # the verdict check run, which is also the verdict store
  pull-requests: write   # the PR review, inline comments and the round-history comment
  contents: read         # the diff, and the reviewers' read-only clone of the head SHA
```

You do not need `actions/checkout`. The Action clones the head SHA itself into `RUNNER_TEMP` with the token, and
reviewers only read that clone.

## Minimal workflow

```yaml
# .github/workflows/merge-safely.yml
name: merge-safely
on:
  pull_request:
    # `edited` re-reviews a PR retargeted to another base branch, under that branch's policy
    # (title and body edits are ignored).
    types: [opened, synchronize, reopened, ready_for_review, edited]
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

Draft PRs are skipped with a notice. They are reviewed on `ready_for_review`.

**Superseded runs stand down.** A run for a commit that is no longer the PR head finishes green with
`decision=skipped` and a notice "superseded by `<sha>`". This happens when a newer push wins the race, or when an old
job is re-run. The newer push gets its own run.

## Multiple providers and fallback

```yaml
      - uses: simonstaton/merge-safely@v0
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
            openai-main:    { provider: openai,    apiKeyEnv: OPENAI_API_KEY }
```

With two connections, hunters alternate across them (`models.decorrelate: true`). Name the fallback in the
policy on the default branch:

```yaml
models:
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }
```

Full example: [examples/action-multi-provider/](../../examples/action-multi-provider/).

## Re-running a review

- **Push** a commit. The new head gets a new review and a new check run.
- **Re-run the job** from the Actions tab. This delivers the original event again.
- **`workflow_dispatch`** re-runs a review on demand, including for fork PRs once a maintainer has looked at them:

```yaml
on:
  workflow_dispatch:
    inputs:
      pr: { description: "PR number", required: true }
      sha: { description: "Expected PR head (optional; fails if the PR has moved)", required: false }
jobs:
  review:
    runs-on: ubuntu-latest
    permissions: { checks: write, pull-requests: write, contents: read }
    steps:
      - uses: simonstaton/merge-safely@v0
        with:
          pr-number: ${{ inputs.pr }}
          head-sha: ${{ inputs.sha }}
          connections: |
            anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

The Action also handles `check_run` `rerequested`, but only when the check run's name equals the base-branch
policy's `reporting.checkName` and the check was written by a trusted app (`verdict-app-slugs` plus the token's own
app). Anything else is skipped. GitHub does not send `check_run` events to workflows for checks created by the
workflow token. With the default token, the "Re-run" button re-runs the job with its original event instead, so
this path only matters with a GitHub App token. `check_suite` events are always ignored: with the workflow token
they only ever come from another app's suite.

## Merge queue

Add `merge_group` to the workflow's triggers and require `merge-safely/verdict` in the merge queue's ruleset:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
  merge_group:
    types: [checks_requested]
concurrency:
  group: merge-safely-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The queue commit is a new SHA that the gate never reviewed. Reviewing it again would double the model bill and
find nothing new, so the Action does not. Instead it reads the PR number from the queue branch
(`gh-readonly-queue/<base>/pr-<n>-<sha>`) and looks up the stored verdict on the PR's current head. Then it writes the
required check on the queue commit:

- **success** when the PR has a machine or human `pass` on its current head that is not contested or expired. The
  summary lists the PRs and the SHAs of their verdicts.
- **failure** otherwise. The summary names the PR and the reason: no verdict, a block, a pending or contested
  verdict, or a verdict on an older commit.

This step makes no model calls and ignores `connections`. The policy is read from the queue's target branch, and
only `reporting.checkName` matters here. Verdicts count only when they were written by an app in
`verdict-app-slugs` (default `github-actions`) or by the token's own app.

The Action checks only the PR named in the queue branch. GitHub gives every queue entry its own branch and its own
`merge_group` run, so each PR in a grouped merge is checked by its own run. The combined commit of several PRs is
never reviewed as a whole.

### App for PRs, Action for the merge queue

The GitHub App does not handle `merge_group` yet. You can let the App review PRs and run this Action only for the
queue commit, trusting the App's check runs:

```yaml
on:
  merge_group:
    types: [checks_requested]
permissions:
  checks: write
  pull-requests: read
  contents: read
jobs:
  merge-queue:
    runs-on: ubuntu-latest
    steps:
      - uses: simonstaton/merge-safely@v0
        with:
          verdict-app-slugs: merge-safely   # your installed App's slug
```

No `connections` are needed on `merge_group`. In the ruleset, require `merge-safely/verdict` from the App on PRs and from GitHub Actions on the merge queue.
The workflow token cannot call `GET /app`, so its own identity is `github-actions`.

## Fork PRs and `pull_request_target`

On `pull_request`, GitHub gives fork PRs a read-only token and no secrets. The Action detects a fork, where the
head repository differs from the base, and fails early with instructions. It does not fail later with a confusing
validation error.

To review fork PRs, use `pull_request_target`. Read [security.md](../../docs/security.md#fork-prs-and-pull_request_target)
first. Here is what the Action guarantees on that event:

- **The policy comes from the base branch.** A fork cannot edit `.merge-safely.yml` to loosen its own review. The
  `policy` checkout override (below) is ignored on fork PRs.
- **No PR code is executed.** Reviewers only read the code, through read-only tools in a disposable clone. If
  `runner.allowedCommands` is set, the Action logs a `SECURITY` warning on fork PRs and runs with
  `allowedCommands: []`. The verdict's policy hash records the rules that were actually applied.
- Secrets reach the model provider only, and they are masked in logs.

What you must do yourself:

- Add no other steps that build, install or run the checked-out PR code in this job.
- Use a model key with a low provider spend limit, and keep `budget.perChangeUsd` low.
- Consider "Require approval for fork pull request workflows" for first-time contributors.

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
```

## Policy source

The policy is fetched with the API from the PR's base branch, at the `policy` path. A pull request cannot change
the rules it is judged by.

There is one escape hatch. If you set `policy` explicitly, the file exists in the runner's checkout
(`GITHUB_WORKSPACE`), and the PR is not from a fork, the checkout's copy is used instead. This suits a policy kept in
a separate config repository that an earlier step checks out. It is refused on fork PRs because the checkout may
contain the fork's code. On same-repository PRs, the author can already edit workflows, so it opens nothing new.
Still, check out a trusted ref (not the PR head) if you rely on it.

## Budgets

Per-seat and per-change ceilings are enforced. The per-change ceiling also counts the cost of earlier rounds that
the check-run store records. The rolling-window (`budget.windowUsd`), all-time (`budget.spendLimitUsd`) and monthly
(`budget.perInstallationMonthlyUsd`) ceilings are **advisory** in the Action. Each job starts with an empty ledger
and cannot see spend from other jobs, so enforcing them would mean checking one job's spend alone and failing open
without saying so. The Action reports them and never blocks on them. If any of them is set in the policy, it logs one
warning: "not enforceable in the Action: spend across jobs is not visible; use the App". A budget stop fails the job with exit code 3 and names
the ceiling to raise. See [budgets.md](../../docs/budgets.md).

## Versioning

- `simonstaton/merge-safely@v0` follows the latest v0 release. The `v0` tag moves forward with each release.
- `@v0.1.0` (an exact tag) or a full commit SHA pins a version. Pinning a SHA is the safest choice for a security gate.
- `@main` tracks unreleased work. It is for the brave.

The action will also be published as `merge-safely/action@v0`, with the same inputs.

## How `dist/` is built

GitHub runs `packages/action/dist/index.js` directly (`runs.using: node20`), so the bundle is committed. Next to it
is `dist/git-wrapper.js`, the `ms-git` guard that the Claude Code CLI runner (`runner: cli` connections) launches.
The runner resolves it relative to the bundle.

```bash
npm run build                          # tsc -b: the workspace packages the bundle imports
npm run bundle -w @merge-safely/action # esbuild -> dist/index.js + dist/git-wrapper.js (CommonJS, node20)
```

`scripts/bundle.mjs` runs esbuild with `--bundle --platform=node --target=node20 --format=cjs`. It also does three
things a single-file CommonJS bundle needs:

- It aliases `@merge-safely/store-sqlite` to a stub and keeps `better-sqlite3` external. The Action uses the
  check-run store, and the native addon cannot ship in a single file.
- It defines `import.meta.url` as the bundle's own file URL.
- It writes `dist/package.json` with `"type": "commonjs"`.

CI rebuilds the bundle and fails on any difference in `packages/action/dist`, whether a file changed or a new one
appeared. Re-bundle and
commit `dist/` whenever you change the Action or a package it imports. The TypeScript build output goes to `lib/`
(ignored by git).
