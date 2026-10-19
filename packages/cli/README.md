# @merge-safely/cli

The `merge-safely` command line. It runs the same pipeline as the GitHub Action and the App: connect your model
providers, review a pull request, review your working tree before you push, estimate cost, and record human
verdicts.

```bash
npx merge-safely --help
```

Node 20 or later.

## Commands

### `connect <provider>`

```
merge-safely connect <provider> [--id <id>] [--api-key-env <ENV>] [--api-key <key>] [--base-url <url>]
                                [--model <name>] [--runner cli] [--subscription] [--label <text>] [--no-validate]
```

Providers: `anthropic`, `openai`, `gemini`, `openai-compatible`, `anthropic-compatible`, `openrouter`, `together`,
`groq`, `fireworks`, `ollama`, `lmstudio`.

```bash
merge-safely connect anthropic                                   # interactive: prompts for the key, echo off
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY   # stores only the variable name
merge-safely connect openai --api-key-env OPENAI_API_KEY --id openai-main
merge-safely connect openrouter --api-key-env OPENROUTER_API_KEY
merge-safely connect openai-compatible --base-url https://gateway.example.com/v1 --api-key-env GATEWAY_KEY
merge-safely connect ollama --model qwen2.5-coder
merge-safely connect anthropic --runner cli --api-key-env ANTHROPIC_API_KEY   # Claude Code CLI runner
merge-safely connect anthropic --subscription                                 # your Claude Code login, opt-in
```

What it does:

1. Builds the connection (`--id` defaults to `<provider>-main`, which is what policy refers to).
2. Validates it with the provider (a cheap models call) unless `--no-validate`. On failure nothing is saved.
3. Prints the models the connection can reach and, for a typical 300-line PR, which models each tier would seat
   and the estimated cost per tier, plus the budget ceilings of the policy in the current directory (or the
   defaults). The estimate assumes no prompt caching, so it errs high.
4. Saves it to the connections file (mode `0600`, directory `0700`). Re-connecting an existing id replaces it
   (that is how you rotate a key). Other entries are left exactly as stored.

How the secret is stored (first match wins):

| Situation | Stored as |
|---|---|
| no secret (`--subscription`, `ollama`, `lmstudio`, keyless compatible) | a plain record, never encrypted. |
| `--api-key-env NAME` | `secretRef: { env: NAME }`. The value is never written, even with a master key set. |
| `MERGE_SAFELY_MASTER_KEY` set | envelope-encrypted blob (`secretRef.encrypted`). |
| otherwise | plaintext in the `0600` file, with a warning. |

The cost table comes from the core's own seating for this connection: the policy's `models.*` (from a
`.merge-safely.yml` in the current directory) when they name it, otherwise the automatic choice. `--model` is used
only when the connection lists no models (seating then trusts the default model); the table says when that is the
case. Unknown models are priced at the pessimistic fallback rate, and the table marks it. A validation failure that
looks like a network problem says the endpoint is unreachable rather than asking you to fix the key.

When stdin is not a terminal and no key flag is given, `connect` uses the provider's conventional variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) as an env reference if it is
set, and otherwise fails with `error [MISSING_API_KEY]`. `--api-key` works but lands in your shell history.

### `connections list | test [id] | remove <id> | path`

```bash
merge-safely connections list          # id, provider, kind, label, model, last validated, secret (masked)
merge-safely connections test          # validate every connection; exit 2 if any fails or cannot be loaded
merge-safely connections test openai-main
merge-safely connections remove openai-main
merge-safely connections path
```

`list` never decrypts anything and never prints a secret: the secret column shows `env:NAME`, `encrypted`,
`file:path`, `plaintext …k3Fd`, `login` or `no key`. `test` records `lastValidatedAt` for connections that pass,
and reports an entry that cannot be loaded (unset env variable, missing or wrong master key) as a `FAIL` with the
reason.

### `run --repo <owner/name> --pr <n>`

```
merge-safely run --repo <owner/name> --pr <n> [--policy <path>] [--report github|status|stdout|json]
                 [--store fs|sqlite|checkrun] [--head <sha>] [--slack-webhook <url>] [--dry-run] [--concurrency <n>]
```

```bash
merge-safely run --repo my-org/my-repo --pr 1234
merge-safely run --repo my-org/my-repo --pr 1234 --report stdout
merge-safely run --repo my-org/my-repo --pr 1234 --report github --store checkrun   # App or Actions token
merge-safely run --repo my-org/my-repo --pr 1234 --report json > verdict.json
```

- **Token:** `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token` if the GitHub CLI is installed and logged in.
- **Policy:** `--policy <path>`, else `.merge-safely.yml` read from the PR's **base** branch (never the head, so a
  pull request cannot loosen its own review), else the defaults.
- **Reporting** (`--report`): `github` writes the check run and the PR review; `status` writes a commit status and
  the PR review; `stdout` and `json` post nothing. The default is `github` when the token is an App installation or
  Actions token (`ghs_…`, or a non-PAT `GITHUB_TOKEN` inside Actions; a `ghp_`/`github_pat_`/`gho_` token is always a user token) and `status` otherwise, because the Checks API is
  App-only. The digest is printed to stdout too, except with `--report json`, which prints the result as JSON
  instead.
- **Store** (`--store`): default `checkrun` with an App/Actions token, else `fs`; the store in use is printed on
  stderr. `fs` lives under `$MERGE_SAFELY_HOME/store`, `sqlite` at
  `$MERGE_SAFELY_HOME/merge-safely.db` (also used as the cost ledger), or `checkrun` (the verdict lives in the
  check run, like the Action; needs an App/Actions token). The cost ledger is the fs ledger unless `--store sqlite`.
- **Workspace:** a disposable clone of the PR head under `$MERGE_SAFELY_HOME/repos`.
- **Escalation:** `--slack-webhook <url>` or `MERGE_SAFELY_SLACK_WEBHOOK` sends escalations to Slack.
- `--head <sha>` reviews that head SHA; if the PR head has moved since, the run refuses with `head-moved` (exit 2).
- **Fail fast:** triage runs first; a change it auto-passes validates no connection at all. Otherwise the connections
  the seated panel uses are validated before any model call (15 s each). A dead connection the policy names stops the
  run with `error [CONNECTION_UNREACHABLE]`, naming it and the fix; under automatic model choice it is skipped with
  a warning and the panel is re-seated without it.
- **Ctrl-C / SIGTERM** cancels cleanly: an in-progress check run (or status) is completed as an interrupted
  failure, checkouts are removed, and the command exits 130.
- `--dry-run` runs the review but writes nothing to GitHub or the store.
- `--concurrency <n>` seats run in parallel (default 2, gentler on provider rate limits than the core's 4).

### `run --local`

```
merge-safely run --local [--base <ref>] [--policy <path>] [--json] [--concurrency <n>]
```

Reviews your working tree against a base: committed, staged, unstaged and untracked (not ignored) changes,
diffed from `merge-base(<base>, HEAD)`. The base defaults to the repository's default branch
(`git symbolic-ref refs/remotes/origin/HEAD`, e.g. `origin/main`), else `main`. The policy is `--policy`, else the
repo's own `.merge-safely.yml`, else the defaults. No verdict store, nothing posted to GitHub; the digest prints
to stdout. Nothing is dropped: if the diff exceeds 2 MB, the files past the cap are left out of what reviewers see,
a warning names them, and the change is treated as tier 3 with no auto-pass. PR-only flags (`--repo`, `--pr`,
`--report`, `--store`, `--head`, `--slack-webhook`, `--dry-run`) are rejected with a usage error. Reviewers read the working tree in place through the read-only tool set. Spend is still recorded in the
local cost ledger.

### `estimate`

```bash
merge-safely estimate --repo my-org/my-repo --pr 1234
merge-safely estimate --local [--base origin/main]
```

Prints the tier and why, the seats with the model and connection each would use, the estimated cost, the budget
ceilings and whether admission would run or refuse the review. No model is called. Exit 0 when the review would
be admitted, 3 when a ceiling would refuse it.

### `explain --repo <owner/name> --pr <n> [--store fs|sqlite|checkrun]`

Prints the digest of the latest verdict for the PR from the store. Exit code follows that verdict (0 pass,
1 block, 2 pending/contested or no verdict). It calls no model, so it needs no usable model connection.

**Stores must match.** `explain`, `verdict` and later `run`s only see verdicts in the store they use. The Action
keeps verdicts in check runs: for a repo gated by the Action use `--store checkrun` (the default with an App or
Actions token). A verdict in a local `fs` store is invisible to the Action.

### `verdict`

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 --sha 3f2c9e1a7b04d6e5c8f9a0b1c2d3e4f5a6b7c8d9 \
  --decision pass --reason "Backfill batching checked by hand; table is under 10k rows."
```

Records a SHA-bound human verdict (for an escalated review). A push after it makes it stale like any machine
verdict.

- `--sha` must be the full 40- (or 64-) character SHA and the PR's current head; anything else is refused with
  `SHA_NOT_HEAD` unless `--allow-stale-sha` is given (then it warns).
- The signer is the token's own user (`GET /user`); `--as <login>` must match it (`SIGNER_MISMATCH` otherwise).
  When the token has no user (App/Actions tokens), `--as` or `GITHUB_ACTOR` is used and a warning says the signer
  is self-declared.
- The PR author can never sign (`SIGNER_IS_AUTHOR`).
- All flags are checked before any network call. No model connection is needed.

### `policy lint [path]` and `policy init [path]`

```bash
merge-safely policy init      # writes a commented .merge-safely.yml with the defaults; refuses to overwrite
merge-safely policy lint      # schema errors (exit 1), plus warnings for connections that do not exist
```

`lint` reports every schema error, including unknown keys inside a section (a typo such as `tiers.criticalPath`),
and warns about `models.*` entries that name a connection missing from your connections file and about unknown
lenses.

### `eval`

```bash
merge-safely eval --suite packages/evals/suites/starter --dry          # tiering and triage only, no model calls
merge-safely eval --suite incidents/ --format markdown --out report.json
merge-safely eval --suite incidents/ --compare baseline.json           # exit 1 when a case regressed
merge-safely eval init incidents/ --case unbatched-backfill --kind incident --title "Backfill without batching"
```

Everything after `eval` goes to `@merge-safely/evals` (see its README for the suite format and every flag,
including `--policy`, `--ids`, `--kinds` and `--concurrency`). Full runs use the real gate over your connections;
`--dry` needs none and never runs `gh auth token`. Global `--json` selects the JSON report. With a GitHub token available, GitHub-sourced cases are fetched with it. Exit codes are passed
through: 0 every gate holds, 1 a gate failed (a case failed, recall or false-block thresholds, or a regression
against `--compare`), 2 usage or suite validation error. Global options (`--home`, `--connections`, `--verbose`)
go before `eval`.

### `version`

`merge-safely version` (or `--version`).

## Global options

| Option | Meaning |
|---|---|
| `--home <dir>` | State directory. Default `$MERGE_SAFELY_HOME`, else `~/.merge-safely`. |
| `--connections <path>` | Connections file. Default `<home>/connections.json`. |
| `--json` | Machine-readable output on stdout (where it makes sense). |
| `--verbose` | Progress and debug lines on stderr. |
| `--no-color` | No colour. Colour is also off when stdout is not a TTY or `NO_COLOR` is set. |

Errors are always one line on stderr, `error [CODE]: message`, with every known secret (connection keys, the
GitHub token, the Slack webhook, the master key) and secret-shaped strings masked.

## Environment

| Variable | Meaning |
|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub token for PR commands (falls back to `gh auth token`). |
| `MERGE_SAFELY_HOME` | State directory (connections, fs store, SQLite db, repo clones). |
| `MERGE_SAFELY_MASTER_KEY` | When set, `connect` encrypts secrets at rest, and loading decrypts them. |
| `MERGE_SAFELY_SLACK_WEBHOOK` | Slack incoming webhook for escalations. |
| `GITHUB_ACTOR` | Fallback signer for `verdict` when the token has no user. |
| `NO_COLOR` | Disable colour. |
| provider keys | Whatever variables your connections reference (`--api-key-env`). |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | pass (or the command succeeded) |
| `1` | block (`run`, `explain`), or `policy lint` found errors |
| `2` | pending, contested, error, or a usage/configuration problem |
| `3` | blocked by budget (`run`), or `estimate` says admission would refuse |
| `130` | interrupted (SIGINT / SIGTERM) |

## Pre-push hook

`run --local` exits non-zero on anything but a pass, so it drops straight into a git hook. A ready-made one is in
[`examples/local-precommit/pre-push`](../../examples/local-precommit/pre-push); the core of it is:

```sh
#!/bin/sh
merge-safely run --local --base "${MERGE_SAFELY_BASE:-origin/main}" || {
  echo "merge-safely: fix the findings above, or push with --no-verify to skip once" >&2
  exit 1
}
```

Use `merge-safely estimate --local` to see what a push will cost first. Tiny docs-only changes are triaged with no
model call. Because the hook reviews the working tree, uncommitted changes are included.

## Programmatic use

```ts
import { defaultContext, runCli } from "@merge-safely/cli";

const code = await runCli(["run", "--local", "--json"], defaultContext());
```

`CliContext` lets you replace the streams, environment, `git`/`gh` execution, the provider registry, the GitHub
client and the gate factory, which is how the tests run every command without a network.
