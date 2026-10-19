# Quickstart: CLI

The `merge-safely` CLI runs the same pipeline as the Action and the App. Use it to review your working tree before you open a PR, to review a PR from your machine, to estimate cost, to record human verdicts and to manage connections. The complete flag reference is [packages/cli/README.md](../packages/cli/README.md).

## Install

Node 20 or later, and `git` on your `PATH`. The packages are not published to npm yet, so install from a checkout:

```bash
git clone https://github.com/simonstaton/merge-safely.git
cd merge-safely
npm ci
npm run build
npm link -w packages/cli        # puts `merge-safely` on your PATH
merge-safely --help
```

Without `npm link`, run `node packages/cli/dist/bin.js` from the checkout instead of `merge-safely`.

## 1. Connect a model

```bash
export ANTHROPIC_API_KEY=sk-ant-...
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY
```

`connect` validates the connection with the provider (a cheap models call), prints the models it can reach, the models each tier would seat and the estimated cost per tier for a typical 300-line PR, and saves the connection to `~/.merge-safely/connections.json` (mode `0600`, directory `0700`). With `--api-key-env`, only the variable name is stored, never the value. The connection id defaults to `<provider>-main`; that id is what policy refers to.

Other providers:

```bash
merge-safely connect openai --api-key-env OPENAI_API_KEY
merge-safely connect gemini --api-key-env GEMINI_API_KEY
merge-safely connect openrouter --api-key-env OPENROUTER_API_KEY        # also together, groq, fireworks
merge-safely connect openai-compatible --base-url https://gateway.example.com/v1 --api-key-env GATEWAY_KEY
merge-safely connect ollama --model qwen2.5-coder                        # also lmstudio; no key
merge-safely connect anthropic --runner cli --api-key-env ANTHROPIC_API_KEY   # Claude Code CLI runner
merge-safely connect anthropic --subscription --id claude-sub            # your Claude Code login, opt-in
```

Run interactively with no key flag and `connect` prompts for the key with echo off. In a script (stdin not a terminal) it falls back to the provider's conventional variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) as an env reference, and otherwise fails with `error [MISSING_API_KEY]`. `--no-validate` saves without calling the provider. On a validation failure nothing is saved.

Check them:

```bash
merge-safely connections list            # secrets masked: env:NAME, encrypted, plaintext …k3Fd, login, no key
merge-safely connections test            # validate every connection; exit 2 if any fails
merge-safely connections test openai-main
merge-safely connections remove openai-main
merge-safely connections path            # where the connections file lives
```

Every kind, field and storage rule is in [connections.md](connections.md).

## 2. Review your working tree

```bash
merge-safely estimate --local
merge-safely run --local
merge-safely run --local --base origin/main --policy .merge-safely.yml
```

`run --local` reviews your working tree against a base: committed, staged, unstaged and untracked (not ignored) changes, diffed from `merge-base(<base>, HEAD)`. The base defaults to the repository's default branch (`refs/remotes/origin/HEAD`), else `main`. The policy is `--policy`, else the repository's own `.merge-safely.yml`, else the defaults.

- Nothing is stored and nothing touches GitHub. The digest prints to stdout. Spend is still recorded in the local cost ledger.
- Reviewers read the working tree in place through the read-only tool set.
- If the diff exceeds 2 MB, the files past the cap are left out of what reviewers see, a warning names them, and the change is treated as tier 3 with no auto-pass.
- Triage runs first: a change it auto-passes (docs-only, for example) validates no connection, so a dead one cannot block it. Otherwise the connections the seated panel uses are validated (15 s each) before any model call. If the one the policy names is down, the run stops with `error [CONNECTION_UNREACHABLE]`.
- PR-only flags (`--repo`, `--pr`, `--report`, `--store`, `--head`, `--slack-webhook`, `--dry-run`) are rejected with `error [USAGE]`.
- With no connections at all, `run --local` and `estimate --local` stop with `error [NO_CONNECTIONS]` (exit 2).

`estimate` prints the tier and why, the seats with the connection and model each would use, the estimated cost, the budget ceilings and whether admission would run or refuse the review. No model is called and nothing is billed. Exit 0 when the review would be admitted, 3 when a ceiling would refuse it.

To run it on every push, see [examples/local-precommit/](../examples/local-precommit/).

## 3. Review a pull request

```bash
export GITHUB_TOKEN=ghp_...        # or GH_TOKEN, or a logged-in `gh` CLI
merge-safely estimate --repo my-org/my-repo --pr 1234
merge-safely run --repo my-org/my-repo --pr 1234 --dry-run
merge-safely run --repo my-org/my-repo --pr 1234 --report stdout
merge-safely run --repo my-org/my-repo --pr 1234 --report json > verdict.json
merge-safely run --repo my-org/my-repo --pr 1234 --report github --store checkrun   # App or Actions token
merge-safely explain --repo my-org/my-repo --pr 1234
merge-safely explain --repo my-org/my-repo --pr 1234 --store checkrun               # verdicts written by the Action
```

| Option | Values | Meaning |
|---|---|---|
| `--report` | `github`, `status`, `stdout`, `json` | Where the verdict goes. `github` writes the check run and the PR review. `status` writes a commit status and the PR review. `stdout` and `json` post nothing. Default: `github` with an App installation or Actions token, `status` with a personal token (the Checks API is App-only). The digest always prints to stdout, except with `json`, which prints the outcome, exit code, headline and full `Verdict` as JSON instead. |
| `--store` | `fs`, `sqlite`, `checkrun` | Where verdicts are kept. `fs` is `$MERGE_SAFELY_HOME/store`, `sqlite` is `$MERGE_SAFELY_HOME/merge-safely.db` (also the cost ledger), `checkrun` keeps the verdict in the PR's check run, like the Action. Default: `checkrun` with an App or Actions token, `fs` otherwise. The store in use is printed on stderr. |
| `--policy` | path | Policy file. Default: `.merge-safely.yml` read from the PR's **base** branch, so a PR cannot loosen its own review; then the built-in defaults. |
| `--head` | sha | Review this head SHA. If the PR head has moved since, the run refuses with `head-moved` (exit 2). |
| `--slack-webhook` | url | Send escalations to a Slack incoming webhook (or set `MERGE_SAFELY_SLACK_WEBHOOK`). |
| `--concurrency` | 1 to 32 | Seats run in parallel. Default 2. |
| `--dry-run` | | Run the review but write nothing to GitHub or the store. |

The token is `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. A token starting `ghs_`, or a non-PAT `GITHUB_TOKEN` inside GitHub Actions, counts as an App or Actions token; `ghp_`, `github_pat_`, `gho_` and `ghu_` tokens are user tokens. With a user token, `--report github` or `--store checkrun` prints a warning, because those need an App or Actions token.

The PR is checked out as a disposable clone of the head SHA under `$MERGE_SAFELY_HOME/repos`. Unless triage auto-passes the change, `run` validates the connections the seated panel uses (15 s each) and stops with `error [CONNECTION_UNREACHABLE]` when one the policy names is down; under automatic model choice a dead connection is skipped with a warning and the panel is re-seated without it. Ctrl-C (SIGINT or SIGTERM) cancels the review: an in-progress check run or status is completed as an interrupted failure, the checkouts are removed, and the command exits 130.

`explain` prints the digest of the latest verdict for the PR from the store. It calls no model and needs no usable connection. Its exit code follows that verdict (0 pass, 1 block, 2 pending, contested or no verdict).

**Stores must match.** `explain`, `verdict` and later `run`s only see verdicts in the store they use. The Action keeps verdicts in check runs, so for a repo gated by the Action use `--store checkrun`, which is already the default with an App or Actions token. A verdict recorded in a local `fs` store is invisible to the Action and will not change its check run.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | pass, or the command succeeded |
| `1` | block (`run`, `explain`), or `policy lint` found errors |
| `2` | pending, contested, error, or a usage or configuration problem (`error [USAGE]`, `error [NO_CONNECTIONS]`, ...) |
| `3` | blocked by budget (`run`), or `estimate` says admission would refuse |
| `130` | interrupted (SIGINT or SIGTERM) |

Errors are one line on stderr, `error [CODE]: message`, with every known secret masked.

## Recording a human verdict

When a review escalates, a person decides. The decision is bound to a head SHA like any machine verdict:

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 \
  --sha 3f2c9e1a7b04d6e5c8f9a0b1c2d3e4f5a6b7c8d9 \
  --decision pass --reason "Backfill batching checked by hand; table is under 10k rows." \
  --store checkrun
```

- `--sha`, `--decision` (`pass` or `block`) and `--reason` are required, and every flag is checked before any network call.
- `--sha` must be the full 40- (or 64-) character SHA of the PR's current head. Any other SHA is refused with `SHA_NOT_HEAD` unless you pass `--allow-stale-sha`, and then it does not satisfy the check for the current head.
- The signer is the user of the GitHub token (`GET /user`). `--as <login>` must match it (`SIGNER_MISMATCH` otherwise). With an App or Actions token, which has no user, `--as` or `GITHUB_ACTOR` is used and a warning says the signer is self-declared.
- The PR's author cannot sign its verdict (`SIGNER_IS_AUTHOR`).
- No model connection is needed.

A push after this makes it stale, exactly like a machine verdict. For a repo gated by the self-hosted App, record human verdicts through the App's API instead (see [quickstart-app.md](quickstart-app.md#escalation)), because the App keeps its verdicts in its own database.

## Policy tools

```bash
merge-safely policy init [path]    # write a commented starter .merge-safely.yml with the defaults; never overwrites
merge-safely policy lint [path]    # validate it against the schema and your connections
```

`policy lint` exits 1 on any schema error and 2 when the file does not exist (`POLICY_NOT_FOUND`). Unknown keys are rejected at every level, so a typo such as `tiers.criticalPath` is an error, not a silently ignored key. It also warns when `models.*` names a connection missing from your connections file, when a panel names an unknown lens, and when the thresholds are out of order. Run it in CI. See [policy.md](policy.md).

## Evals

```bash
merge-safely eval --suite packages/evals/suites/starter --dry      # tiering, triage and seating only; no model calls
merge-safely eval --suite incidents/ --format markdown --out report.json
merge-safely eval --suite incidents/ --compare baseline.json       # exit 1 when a case regressed
merge-safely eval init incidents/ --case unbatched-backfill --kind incident --title "Backfill without batching"
```

A suite is a set of past changes with known outcomes: incident cases must block, clean cases must pass. A full run reviews each case with the real gate over your connections and reports recall and false-block rate per tier, lens and model. `--dry` needs no connections. Exit codes: 0 every gate holds, 1 a gate failed, 2 usage or suite validation error. Global options (`--home`, `--connections`, `--json`, `--verbose`) go before `eval`. The suite format is in [packages/evals/README.md](../packages/evals/README.md).

## Global options

| Option | Meaning |
|---|---|
| `--home <dir>` | State directory. Default `$MERGE_SAFELY_HOME`, else `~/.merge-safely`. |
| `--connections <path>` | Connections file. Default `<home>/connections.json`. |
| `--json` | Machine-readable output on stdout (where it makes sense). |
| `--verbose` | Progress and debug lines on stderr. |
| `--no-color` | No colour. Colour is also off when stdout is not a TTY or `NO_COLOR` is set. |

## Environment

| Variable | Meaning |
|---|---|
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token for PR commands (falls back to `gh auth token`). Needs read on contents and pull requests; write on checks (App or Actions token), commit statuses and pull requests to report. |
| `MERGE_SAFELY_HOME` | State directory. Default `~/.merge-safely`. Holds `connections.json` (mode `0600`), the fs store and ledger (`store/`), the SQLite database (`merge-safely.db`) and PR clones (`repos/`). The directory is kept at mode `0700`. |
| `MERGE_SAFELY_MASTER_KEY` | Optional. When set, `connect` encrypts secrets at rest (except `--api-key-env` references and connections with no secret), and loading decrypts them. See [connections.md](connections.md#encryption-at-rest). |
| `MERGE_SAFELY_SLACK_WEBHOOK` | Optional. Slack incoming webhook for escalations (same as `--slack-webhook`). |
| `GITHUB_ACTOR` | Fallback signer for `verdict` when the token has no user (App or Actions tokens). |
| `NO_COLOR` | Disable colour. |

Provider keys are read from whatever variables your connections name (`--api-key-env`).
