# Quickstart: CLI

The `merge-safely` CLI runs the same pipeline as the Action and the App. Use it to review your working tree before you open a PR, to review a PR from your machine, to estimate cost, and to manage connections.

## Install

Node 20 or later.

```bash
npx merge-safely --help
```

From a checkout of this repository:

```bash
npm install
npm run build
node packages/cli/dist/bin.js --help
```

## 1. Connect a model

```bash
export ANTHROPIC_API_KEY=sk-ant-...
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY
```

`connect` validates the key (a cheap models-list call), shows the models it can reach, and saves the connection to `~/.merge-safely/connections.json` with mode `0600`. With `--api-key-env`, only the variable name is stored, never the value.

Other providers:

```bash
merge-safely connect openai --api-key-env OPENAI_API_KEY
merge-safely connect gemini --api-key-env GEMINI_API_KEY
merge-safely connect openrouter --api-key-env OPENROUTER_API_KEY
merge-safely connect ollama --model qwen2.5-coder
merge-safely connect anthropic --runner cli            # use the Claude Code CLI runner
```

Check them:

```bash
merge-safely connections list
merge-safely connections test
merge-safely connections remove openai-main
merge-safely connections path      # where the connections file lives
```

Every kind, flag and file field is in [connections.md](connections.md).

## 2. Review your working tree

```bash
merge-safely estimate --local
merge-safely run --local
merge-safely run --local --base origin/main --policy .merge-safely.yml
```

`run --local` reviews your working tree against the base ref and prints the digest. It does not write a verdict to any store and does not touch GitHub. It uses your repo's `.merge-safely.yml` if one exists. Committed, staged, unstaged and untracked (not ignored) files are all included. If the diff exceeds 2 MB, the files past the cap are left out of what reviewers see, a warning names them, and the change is treated as tier 3 with no auto-pass.

`estimate` prints the tier, the seats, the models chosen for each seat and the estimated cost. Nothing runs and nothing is billed.

To run it on every push, see [examples/local-precommit/](../examples/local-precommit/).

## 3. Review a pull request

```bash
export GITHUB_TOKEN=ghp_...        # or GH_TOKEN
merge-safely estimate --repo my-org/my-repo --pr 1234
merge-safely run --repo my-org/my-repo --pr 1234 --dry-run
merge-safely run --repo my-org/my-repo --pr 1234 --report stdout
merge-safely run --repo my-org/my-repo --pr 1234 --report github --store checkrun
merge-safely explain --repo my-org/my-repo --pr 1234
merge-safely explain --repo my-org/my-repo --pr 1234 --store checkrun   # verdicts written by the Action
```

| Option | Values | Meaning |
|---|---|---|
| `--report` | `github`, `status`, `stdout`, `json` | Where the verdict goes. `github` writes the check run and the PR review. `status` writes a commit status and the PR review. Default: `github` with an App or Actions installation token, `status` with a personal token (the Checks API is App-only). The digest always prints to stdout, except with `json`, which prints the result and the full `Verdict` object instead. |
| `--store` | `fs`, `sqlite`, `checkrun` | Where verdicts are kept. `fs` and `sqlite` live under `MERGE_SAFELY_HOME`. `checkrun` uses the PR's check runs, like the Action. Default: `checkrun` with an App or Actions token, `fs` otherwise. The store in use is printed on stderr. |
| `--policy` | path | Policy file. Default: `.merge-safely.yml` on the PR's **base** branch, so a PR cannot loosen its own review; then the built-in defaults. |
| `--head` | sha | Review this head SHA. If the PR head has moved since, the run refuses with `head-moved` (exit 2). |
| `--slack-webhook` | url | Send escalations to a Slack incoming webhook (or set `MERGE_SAFELY_SLACK_WEBHOOK`). |
| `--concurrency` | n | Seats run in parallel. Default 2. |
| `--dry-run` | | Run the pipeline but write nothing to GitHub or the store. |

Before seating, `run` validates the connections it will use and stops with `error [CONNECTION_UNREACHABLE]` when one the policy names is down. Ctrl-C (SIGINT or SIGTERM) cancels the review: an in-progress check run is completed as a failure that says it was interrupted, the checkout is removed, and the command exits 130.

`explain` prints the digest of the latest verdict for a PR from the store.

**Stores must match.** `explain`, `verdict` and later `run`s only see verdicts in the store they use. The Action keeps verdicts in check runs, so for a repo gated by the Action, use `--store checkrun`, which is already the default with an App or Actions token. A verdict recorded in a local `fs` store is invisible to the Action and will not change its check run.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | pass |
| `1` | block (`policy lint`: errors found) |
| `2` | pending, contested, error, or a usage/configuration problem |
| `3` | blocked by budget (`estimate`: admission would refuse) |
| `130` | interrupted |

## Recording a human verdict

When a review escalates, a person decides. The decision is bound to a head SHA like any machine verdict:

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 \
  --sha 3f2c9e1a7b04d6e5c8f9a0b1c2d3e4f5a6b7c8d9 \
  --decision pass --reason "Backfill batching checked by hand; table is under 10k rows." \
  --store checkrun
```

- `--sha` must be the full 40-character SHA of the PR's current head. Any other SHA is refused with `SHA_NOT_HEAD` unless you pass `--allow-stale-sha`.
- The signer is the user of the GitHub token (`GET /user`). `--as <login>` is only accepted when it matches. With an App or Actions token, which has no user, `--as` or `GITHUB_ACTOR` is used and a warning says the signer is self-declared.
- The PR's author cannot sign its verdict (`SIGNER_IS_AUTHOR`).

A push after this makes it stale, exactly like a machine verdict.

## Policy tools

```bash
merge-safely policy init [path]    # write a commented starter .merge-safely.yml; never overwrites
merge-safely policy lint [path]    # validate it against the schema and your connections
```

Run `policy lint` in CI. Unknown keys are rejected at every level, so a typo such as `tiers.criticalPath` is an error (exit 1), not a silently ignored key. `lint` also warns when `models.*` names a connection you have not made. See [policy.md](policy.md).

## Evals

```bash
merge-safely eval --suite incidents/
```

Runs the pipeline against past changes with known outcomes and reports recall and false-block rate per lens and model.

## Environment

| Variable | Meaning |
|---|---|
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token for PR mode. Needs read on contents and pull requests; write on checks and pull requests to report. |
| `MERGE_SAFELY_HOME` | State directory. Default `~/.merge-safely`. Holds `connections.json` (mode `0600`), the fs store and the SQLite ledger. It is created at mode `0700`, and an existing home that others can read is tightened to `0700` the next time the connections file is written. |
| `MERGE_SAFELY_MASTER_KEY` | Optional. When set, connection secrets are encrypted at rest (except `--api-key-env` references and connections with no secret). See [connections.md](connections.md#encryption-at-rest). |
| `MERGE_SAFELY_SLACK_WEBHOOK` | Optional. Slack incoming webhook for escalations (same as `--slack-webhook`). |
| `GITHUB_ACTOR` | Fallback signer for `verdict` when the token has no user (App/Actions tokens). |

Provider keys are read from whatever variables your connections name (`--api-key-env`).
