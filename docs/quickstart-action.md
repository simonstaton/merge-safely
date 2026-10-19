# Quickstart: GitHub Action

The Action is the zero-infrastructure deployment. It runs on your Actions minutes, against model keys you hold in GitHub secrets. No database, no server.

## 1. Add a model key as a secret

In the repository, go to **Settings → Secrets and variables → Actions** and add, for example, `ANTHROPIC_API_KEY`.

Any supported provider works. See [connections.md](connections.md).

## 2. Add the workflow

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

Open a PR. A check run named `merge-safely/verdict` appears as pending, then turns green (pass) or red (block). On a block, the Action also posts a PR review with the digest and inline comments.

The `concurrency` block cancels a review when a newer commit arrives. The newer commit gets its own review, and the old verdict would have been bound to a SHA that is no longer the head anyway.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `connections` | required | YAML map of connection id to connection. Same fields as the connections file. See [connections.md](connections.md#the-actions-connections-input). Not used on `merge_group` runs. |
| `policy` | `.merge-safely.yml` | Path to the policy file in the repo, read from the PR's **base** branch (never the PR head). A missing file means all defaults. |
| `github-token` | `${{ github.token }}` | Token used to read the PR and write the check run and review. |
| `fail-on-block` | `true` | Fail the job when the verdict is block. Set `false` if you only want the check run to carry the signal. Pending, contested, error and budget-blocked always fail the job. |
| `store` | `checkrun` | Where verdicts live. Only `checkrun` in v0.1. |
| `slack-webhook` | none | Slack incoming-webhook URL for escalations, from a secret. |
| `concurrency` | `2` | Reviewer seats run in parallel (1-16). |
| `pr-number` | none | The PR to review on `workflow_dispatch`. |
| `head-sha` | PR head | Review this commit instead of the PR head. |

Outputs: `decision`, `tier`, `round`, `cost-usd`, `check-url`, `verdict-json`. The job summary carries the digest and the cost line. Full reference: [packages/action/README.md](../packages/action/README.md).

## Permissions

| Permission | Why |
|---|---|
| `checks: write` | Create and update the verdict check run. The check run is also the verdict store in the Action. |
| `pull-requests: write` | Post the PR review and inline comments. |
| `contents: read` | Check out the head SHA for reviewers to read. |

Nothing else is needed. The `github-teams` trust provider needs to read organisation team membership, which the default `GITHUB_TOKEN` cannot do. Use the `allowlist` or `codeowners` trust provider with the Action, or the GitHub App.

## Add a policy (optional)

Commit `.merge-safely.yml` at the repo root. Start empty and add only what you need:

```yaml
version: 1
tiers:
  criticalPaths:
    - "**/migrations/**"
    - "**/auth/**"
    - "services/billing/**"
models:
  hunters: { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:  { connection: anthropic-main, model: claude-opus-5-5 }
```

Setting `criticalPaths` replaces the default list. See [policy.md](policy.md) for every key and default, and [examples/policies/](../examples/policies/) for complete files.

`.merge-safely.yml` is itself a default critical path, so a PR that edits the policy is always reviewed at tier 3.

## Two providers with fallback

```yaml
      - uses: simonstaton/merge-safely@v0
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
            openai-main:    { provider: openai,    apiKey: "${{ secrets.OPENAI_API_KEY }}" }
```

With two connections, hunter seats alternate across them by default (`models.decorrelate: true`). Name a fallback in the policy so one provider's outage or rate limit does not stall review:

```yaml
models:
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }
```

Full workflow: [examples/action-multi-provider/](../examples/action-multi-provider/).

## How the Action stores state

The verdict check run is the verdict store, so verdicts are kept per head SHA and rounds work without a database. A new push gets a new check run on the new SHA; the old one stays attached to the old SHA.

Budgets: per-seat and per-change ceilings are enforced. The monthly installation ceiling (`budget.perInstallationMonthlyUsd`) is evaluated as advisory only, because a single job cannot see spend across all your repositories. Use the GitHub App for enforced installation-wide budgets. See [budgets.md](budgets.md).

## When the key is wrong

The Action validates each connection before seating. A bad or empty key fails the check run with a message that names the connection id and what to fix. The key itself never appears in logs, the check run or the review.

## Fork PRs

On `pull_request` events from forks, GitHub does not expose repository secrets and the token is read-only, so the Action stops early with an explanation instead of failing validation. To review fork PRs, switch to `pull_request_target`, but read [security.md](security.md#fork-prs-and-pull_request_target) first. On that event the Action reads the policy from the base branch and ignores `runner.allowedCommands` on fork PRs (it warns and runs with none), so the fork's code is read but never executed.

## Merge queue

Add `merge_group: { types: [checks_requested] }` to the triggers. On the queue commit the Action makes no model calls. It checks that each queued PR has a `pass` verdict on its current head and reports `merge-safely/verdict` on the queue commit to match. See [packages/action/README.md](../packages/action/README.md#merge-queue).

## Limits

- Actions cold start adds about a minute.
- No installation-wide budget enforcement across repositories.
- No escalation queue beyond a Slack webhook.
- The reviewer workspace is the Actions runner itself.

The [GitHub App](quickstart-app.md) removes these limits.

## Next

- Make the check required: [merge-bots.md](merge-bots.md).
- Tune tiers and panels: [policy.md](policy.md).
- Control spend: [budgets.md](budgets.md).
