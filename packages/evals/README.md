# @merge-safely/evals

Eval suite format, runner, reports and circuit breakers for Merge Safely (design section 10).

The only honest answer to "do we need this much review" is a number. An eval suite is a set of past changes with
known outcomes: **incident-derived cases should block, known-clean cases should pass**. The runner pushes each case
through the same gate production uses and reports recall and false-block rate overall, per tier, per lens and per
model, so policy and model choices are made on evidence.

## Suite format

```
my-suite/
  suite.yml
  unbatched-backfill/
    case.yml
    base/            # the files before the change (repo-relative paths)
    head/            # the same files after the change
  docs-readme-edit/
    case.yml
    base/ head/
```

### `suite.yml`

```yaml
version: 1
name: my-suite
description: Incidents from 2026 plus clean controls
defaults:
  policy:                # policy overrides for every case, merged over the core defaults
    triage: { maxLines: 30 }
  models:                # shorthand for policy.models
    hunters: { connection: anthropic-main, model: claude-sonnet-5-5 }
gates:                   # CLI exit code thresholds (on top of "every case passes")
  minRecall: 0.8         # share of incident cases that must be caught
  maxFalseBlock: 0.1     # share of clean cases allowed to block
extraFindingClasses: []  # classes emitted by custom lenses (built-in lens classes are always known)
extraLenses: []          # custom lens ids
```

### `case.yml`

```yaml
id: unbatched-backfill            # lowercase, unique in the suite
title: Backfill updates a large table in one transaction
kind: incident                    # incident (must block) | clean (must pass) | regression (must hold, either way)
expected:
  decision: block                 # pass | block
  tier: 3                         # optional: 0..3
  triage: review                  # optional: auto-pass | review
  lenses: [perf, rollout]         # optional: lenses that must be seated
  findingClasses: [unbatched-backfill, lock-risk]   # blocks only: at least one must be raised
  files: [services/api/src/jobs/backfillUserStats.ts]  # blocks only: a matching finding must point here
source:                           # one of:
  type: fixture                   #   two trees, diffed by the runner
  base: base/
  head: head/
  # type: diff, diff: change.diff, files?: [{ path, status, additions, deletions }]
  # type: github, repo: owner/name, pr: 123, headSha: <full 40/64-hex sha>, includeComments: false   (needs a token)
change:                           # PR metadata; untrusted, reaches reviewers only as delimited data
  title: Add lifetime value to user stats
  body: Tested locally.
  author: someone
  authorKind: human               # human | bot | agent
  labels: [feature]
policy: {}                        # optional per-case policy overrides
notes: |
  What the incident was and how it was (or should have been) caught.
```

Validation is strict: unknown keys, an incident that expects `pass`, a clean case that expects `block`,
`findingClasses` on a pass, duplicate ids, missing fixture directories, abbreviated SHAs, and `findingClasses` /
`lenses` that no registered lens (`@merge-safely/lenses`, plus the suite's `extra*` lists) knows are all reported
together, with the file and field path, before anything runs. A case whose `base/` and `head/` are identical fails
when it runs, so an unfilled scaffold is never green.

Fixture diffs are computed in a throwaway git repository (base committed, then head), with fixed identities and dates,
so the diff applies with `git apply` on top of `base/` and the base/head SHAs are stable across runs. `.gitkeep` files
are ignored, and an empty `base/` means every file is new. Every git command runs through workspace-local's hardened
`git` helper: inherited `GIT_*` variables (`GIT_DIR`, `GIT_INDEX_FILE`, ... from a surrounding hook) are dropped, HOME
is an empty private directory, and system config and hooks are off.

Symlinks: `base/`, `head/` and `change.diff` must be real paths inside the case directory. Symlinks inside a tree must
be relative and resolve inside that tree; they are committed as symlinks, never dereferenced. Anything else is an error
naming the path, so no file from outside the case can reach a prompt.

**Reviewers get the real tree.** The throwaway repository stays alive for the whole case and is passed to the gate
factory as `ctx.repo = { repoPath, headSha, baseSha }`, with `ctx.workspace` defaulting to
`localWorkspace({ repoPath })`, so seats can check out `headSha` and grep consumers that are not in the diff. It is
deleted after `reviewChange` returns. Diff and github cases are diff-only unless the runner's `workspace` option
supplies a Workspace.

**GitHub cases** are pinned to a full `headSha`. Commit messages are limited to the PR's commits up to and including
that SHA, and comments are left out entirely unless `includeComments: true`, in which case only comments created
before the head commit are kept: post-incident discussion must not hand the reviewer the answer.

## Writing an incident case

```sh
merge-safely eval init evals/ --case orders-lock --kind incident --title "Backfill locked orders"
```

This writes `evals/suite.yml` (if missing) and `evals/orders-lock/` with a commented `case.yml`, empty `base/` and
`head/` trees and a README on reducing the incident:

1. Copy the files the change touched into `head/` (after) and `base/` (before), keeping repo-relative paths: tiering
   matches paths, so `services/api/src/jobs/backfill.ts` must stay exactly that.
2. Add the smallest surrounding code a reviewer needs to see the bug: the caller, the consumer that breaks, the flag
   registry that lacks the flag.
3. Strip everything else. Remove secrets, tokens, internal hostnames, customer names and personal data. Keep the bug.
4. Fill in the expected decision, tier, finding classes and file, and two or three sentences of `notes`.
5. `merge-safely eval --suite evals --ids orders-lock --dry` checks tier, triage and seating without a model.

Programmatically: `initSuite(dir)` and `scaffoldCase(dir, { id, kind, title })`.

## Running

```sh
merge-safely eval --suite <dir> [--dry] [--format text|markdown|json] [--ids a,b] [--kinds incident,clean]
                  [--concurrency n] [--policy policy.yml] [--out report.json] [--compare baseline.json]
```

Flags are parsed strictly: an unknown flag is a usage error (exit 2). `--dry` is boolean; `--dry=false` (or `0`,
`no`, `off`) turns it off, any other value turns it on. `--policy` and `--compare` are validated before anything runs.

- `--dry` runs only `estimate`: the real core tier, triage and seating stages with synthetic connections. No model is
  called and no credentials are needed. Dry runs check `expected.tier`, `expected.triage` and `expected.lenses`, and
  fail any case expected to block that triage would auto-pass.
- A full run calls `gate.reviewChange` per case. Every case gets a freshly built gate with a fresh in-memory verdict
  store and cost ledger, so nothing (stored blocks, spend, rounds) carries between cases.
- `github` sources fetch the PR and the diff pinned to `headSha` through `githubSource`; without a token the case
  errors with "token required". When the PR has moved past the pinned SHA the file list is derived from the pinned
  diff.
- `--policy` merges a policy fragment over every case (after suite and case policy).
- `--out` writes the JSON report; `--compare` diffs against an earlier JSON report in every format (json output gains
  a `comparison` field) and exits 1 when a case regressed.

Exit codes: `0` all gates hold; `1` any case failed or was unresolved (error, pending, contested), recall below
`minRecall`, false-block rate above `maxFalseBlock`, or a `--compare` case regressed; `2` usage, flag or validation
error.

Programmatic use:

```ts
import { runSuite, renderReport, evaluateBreakers } from "@merge-safely/evals";
import { createGate } from "@merge-safely/core";

const result = await runSuite("evals/", {
  gateFactory: (policy, { store, ledger, workspace }) => createGate({ ...deps, policy, store, ledger, workspace }),
  concurrency: 4,
});
console.log(renderReport(result, "markdown"));
```

`gateFactory` receives the merged policy for the case and a context with the fresh per-case store and ledger, the
fixture `repo` and the reviewer `workspace` (pass `workspace` in the `createGate` deps). Any object with
`reviewChange(change, { diff, untrusted })` and `estimate(change)` works, which is how the tests drive the runner with
`scriptedGateFactory`.

## Reading the report

- **Recall**: incidents caught / incident cases, where caught means blocked *and*, when the case names
  `findingClasses` / `files`, a finding with that class and file was raised. Blocking on noise is not recall; the raw
  "blocked for any reason" count is shown next to it.
- **False-block rate**: clean cases that blocked / all clean cases. Each one is a wasted round and erodes trust.
- **Unresolved**: cases that errored or came back `pending` or contested. Each is a case failure.
- **Tier accuracy**: cases whose tier matched `expected.tier`. Every Appendix A incident was a tiering failure, so a
  wrong tier is the first thing to fix.
- **Per tier**: keyed by the tier the gate assigned: recall, misses auto-passed by triage (no reviewer saw them), and
  incidents that landed below their expected tier.
- **Per lens / per model**: how often a lens or model was seated on incidents, how many incidents it caught with the
  *expected* class (blocking for the wrong reason does not count), and how often it raised a blocker on a clean case
  that blocked. A finding is credited to the model of the seat whose own output carried it (falling back to every
  seat on the finding's lenses). Use this to choose models on evidence rather than brand.
- Dry runs print "Cost: not estimated (dry)".
- **Cost and duration**: per-case and total USD from the verdicts, p50/p95 wall time.
- Case reasons say exactly which check failed (`expected tier 3, got tier 1 (score 12 is below t1 (20): tier 0)`,
  `blocked for the wrong reason: no finding with class in [missing-flag] (raised: style@x.ts)`).

## Loosening policy with evidence

`evaluateBreakers(result, { maxFalseBlock?, minRecall?, minIncidentsPerTier? })` is the circuit-breaker hook. It is
pure and only suggests; it never edits a policy.

- False-block rate above threshold: `widenTriage` (raise `triage.maxLines` / `maxFiles`, add docs or asset patterns).
- Incident recall below threshold at a tier: `raiseQuorumTier` (and `raiseQuorumTiers`) for `quorum.t<n>`.
- Misses that triage auto-passed: `narrowTriage`, because more quorum cannot help a change no reviewer sees.
- Incidents tiered below their expected tier: `fixTiering` (add a critical path or tiering rule).

To loosen safely: run the suite, save `--out baseline.json`, change the policy (a cheaper hunter model, fewer t2
lenses, wider triage), run again with `--compare baseline.json`, and only keep the change if no incident flipped to
`REGRESSED` and recall stays above the gate. Add the policy diff and the comparison to the PR that changes
`.merge-safely.yml`.

## Starter suite

`suites/starter/` holds generic reductions of the design's Appendix A week, plus clean controls:

| case | kind | expected | why |
|---|---|---|---|
| `unbatched-backfill` | incident | block, tier 3 | one-transaction UPDATE over all users (`unbatched-backfill`, `lock-risk`) |
| `missing-flag` | incident | block, tier 3 | removes a flag read, reads a flag never declared (`missing-flag`); tier 3 via flag removal |
| `shared-layout-prop-drop` | incident | block, tier 3 | AppShell rebuild silently ignores props its routes pass (`silent-prop-drop`) |
| `post-approval-auth-change` | regression | block, tier 3 | tiny post-approval auth change: 30-day sessions and MFA skip (`authn-bypass`); single-shot, does not exercise SHA pinning across pushes |
| `small-bugfix-with-test` | clean | pass, tier 0, review | refund formatting fix with tests, just over the triage limit |
| `docs-readme-edit` | clean | pass, tier 0, auto-pass | docs only |
| `lockfile-only-bump` | clean | pass, tier 0, auto-pass | lockfile only |

`starter.test.ts` runs it in dry mode against the real core stages on every test run.
