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
```

Every kind, flag and file field is in [connections.md](connections.md).

## 2. Review your working tree

```bash
merge-safely estimate --local
merge-safely run --local
merge-safely run --local --base origin/main --policy .merge-safely.yml
```

`run --local` reviews your working tree against the base ref and prints the digest. It does not write a verdict to any store and does not touch GitHub. It uses your repo's `.merge-safely.yml` if one exists.

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
```

| Option | Values | Meaning |
|---|---|---|
| `--report` | `github`, `stdout`, `json` | Where the verdict goes. `github` writes the check run and PR review. `json` prints the full `Verdict` object. |
| `--store` | `fs`, `sqlite`, `checkrun` | Where verdicts are kept. `fs` and `sqlite` live under `MERGE_SAFELY_HOME`. `checkrun` uses the PR's check runs, like the Action. |
| `--policy` | path | Policy file. Default: `.merge-safely.yml`. |
| `--dry-run` | | Run the pipeline but write nothing to GitHub or the store. |

`explain` prints the digest of the latest verdict for a PR.

## Recording a human verdict

When a review escalates, a person decides. The decision is bound to a head SHA like any machine verdict:

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 --sha 3f2c9e1 \
  --decision pass --reason "Backfill batching checked by hand; table is under 10k rows."
```

A push after this makes it stale, exactly like a machine verdict.

## Policy tools

```bash
merge-safely policy init     # write a starter .merge-safely.yml
merge-safely policy lint     # validate .merge-safely.yml against the schema
```

Run `policy lint` in CI. The parser rejects unknown top-level keys, but unknown keys inside a section (a typo such as `tiers.criticalPath`) are dropped, so a typo can silently leave a default in place. See [policy.md](policy.md).

## Evals

```bash
merge-safely eval --suite incidents/
```

Runs the pipeline against past changes with known outcomes and reports recall and false-block rate per lens and model.

## Environment

| Variable | Meaning |
|---|---|
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token for PR mode. Needs read on contents and pull requests; write on checks and pull requests to report. |
| `MERGE_SAFELY_HOME` | State directory. Default `~/.merge-safely`. Holds `connections.json` (mode `0600`), the fs store and the SQLite ledger. The directory is kept at mode `0700`. |
| `MERGE_SAFELY_MASTER_KEY` | Optional. When set, connection secrets are encrypted at rest. See [connections.md](connections.md#encryption-at-rest). |

Provider keys are read from whatever variables your connections name (`--api-key-env`).
