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

How the secret is stored:

| Situation | Stored as |
|---|---|
| `--api-key-env NAME` | `secretRef: { env: NAME }`. The value is never written. |
| `MERGE_SAFELY_MASTER_KEY` set | envelope-encrypted blob (`secretRef.encrypted`). |
| otherwise | plaintext in the `0600` file, with a warning. |

When stdin is not a terminal and no key flag is given, `connect` uses the provider's conventional variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) as an env reference if it is
set, and otherwise fails with `error [MISSING_API_KEY]`. `--api-key` works but lands in your shell history.

### `connections list | test [id] | remove <id> | path`

```bash
merge-safely connections list          # id, provider, kind, label, model, last validated, secret (masked)
merge-safely connections test          # validate every connection; exit 2 if any fails
merge-safely connections test openai-main
merge-safely connections remove openai-main
merge-safely connections path
```

`list` never decrypts anything and never prints a secret: the secret column shows `env:NAME`, `encrypted`,
`file:path`, `plaintext …k3Fd` or `no key`. `test` records `lastValidatedAt` for connections that pass.

### `run --repo <owner/name> --pr <n>`

```
merge-safely run --repo <owner/name> --pr <n> [--policy <path>] [--report github|status|stdout|json]
                 [--store fs|sqlite|checkrun] [--head <sha>] [--slack-webhook <url>] [--dry-run]
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
  Actions token (`ghs_…`, or `GITHUB_TOKEN` inside Actions) and `status` otherwise, because the Checks API is
  App-only. The digest is always printed to stdout too.
- **Store** (`--store`): `fs` (default) under `$MERGE_SAFELY_HOME/store`, `sqlite` at
  `$MERGE_SAFELY_HOME/merge-safely.db` (also used as the cost ledger), or `checkrun` (the verdict lives in the
  check run, like the Action; needs an App/Actions token). The cost ledger is the fs ledger unless `--store sqlite`.
- **Workspace:** a disposable clone of the PR head under `$MERGE_SAFELY_HOME/repos`.
- **Escalation:** `--slack-webhook <url>` or `MERGE_SAFELY_SLACK_WEBHOOK` sends escalations to Slack.
- `--dry-run` runs the review but writes nothing to GitHub or the store.

### `run --local`

```
merge-safely run --local [--base <ref>] [--policy <path>] [--json]
```

Reviews your working tree against a base: committed, staged, unstaged and untracked (not ignored) changes,
diffed from `merge-base(<base>, HEAD)`. The base defaults to the repository's default branch
(`git symbolic-ref refs/remotes/origin/HEAD`, e.g. `origin/main`), else `main`. The policy is `--policy`, else the
repo's own `.merge-safely.yml`, else the defaults. No verdict store, nothing posted to GitHub; the digest prints
to stdout. Reviewers read the working tree in place through the read-only tool set. Spend is still recorded in the
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
1 block, 2 pending/contested or no verdict).

### `verdict`

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 --sha 3f2c9e1 \
  --decision pass --reason "Backfill batching checked by hand; table is under 10k rows."
```

Records a SHA-bound human verdict (for an escalated review). The signer is `--as <login>`, else the logged-in `gh`
user (`gh api user`), else `GITHUB_ACTOR`. A push after it makes it stale like any machine verdict.

### `policy lint [path]` and `policy init [path]`

```bash
merge-safely policy init      # writes a commented .merge-safely.yml with the defaults; refuses to overwrite
merge-safely policy lint      # schema errors (exit 1), plus warnings for connections that do not exist
```

`lint` reports every schema error, including unknown keys inside a section (a typo such as `tiers.criticalPath`),
and warns about `models.*` entries that name a connection missing from your connections file and about unknown
lenses.

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
| `GITHUB_ACTOR` | Fallback signer for `verdict`. |
| `NO_COLOR` | Disable colour. |
| provider keys | Whatever variables your connections reference (`--api-key-env`). |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | pass (or the command succeeded) |
| `1` | block (`run`, `explain`), or `policy lint` found errors |
| `2` | pending, contested, error, or a usage/configuration problem |
| `3` | blocked by budget (`run`), or `estimate` says admission would refuse |

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
