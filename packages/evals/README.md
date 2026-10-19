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
gates:                   # CLI exit code thresholds
  minRecall: 0.8         # share of incident cases that must block
  maxFalseBlock: 0.1     # share of clean cases allowed to block
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
  # type: github, repo: owner/name, pr: 123, headSha: <sha>   (needs a token)
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
`findingClasses` on a pass, duplicate ids and missing fixture directories are all reported together, with the file and
field path, before anything runs.

Fixture diffs are computed in a throwaway git repository (base committed, then head), with fixed identities and dates,
so the diff applies with `git apply` on top of `base/` and the base/head SHAs are stable across runs. `.gitkeep` files
are ignored, and an empty `base/` means every file is new.

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
                  [--concurrency n] [--out report.json] [--compare baseline.json]
```

- `--dry` runs only `estimate`: the real core tier, triage and seating stages with synthetic connections. No model is
  called and no credentials are needed. Dry runs check `expected.tier`, `expected.triage` and `expected.lenses`, and
  fail any case expected to block that triage would auto-pass.
- A full run calls `gate.reviewChange` per case. Every case gets a freshly built gate with a fresh in-memory verdict
  store and cost ledger, so nothing (stored blocks, spend, rounds) carries between cases.
- `github` sources fetch the PR and the diff pinned to `headSha` through `githubSource`; without a token the case
  errors with "token required". When the PR has moved past the pinned SHA the file list is derived from the pinned
  diff.
- `--out` writes the JSON report; `--compare` diffs against an earlier JSON report.

Exit codes: `0` all gates hold; `1` recall below `minRecall`, false-block rate above `maxFalseBlock`, a regression case
failed, any case errored, or (in `--dry`) any case failed its checks; `2` usage or suite validation error.

Programmatic use:

```ts
import { runSuite, renderReport, evaluateBreakers } from "@merge-safely/evals";
import { createGate } from "@merge-safely/core";

const result = await runSuite("evals/", {
  gateFactory: (policy, { store, ledger }) => createGate({ ...deps, policy, store, ledger }),
  concurrency: 4,
});
console.log(renderReport(result, "markdown"));
```

`gateFactory` receives the merged policy for the case and the fresh per-case store and ledger. Any object with
`reviewChange(change, { diff, untrusted })` and `estimate(change)` works, which is how the tests drive the runner with
`scriptedGateFactory`.

## Reading the report

- **Recall**: incident cases that blocked / incident cases. A miss is a change that would have reached production.
- **False-block rate**: clean cases that blocked / clean cases. Each one is a wasted round and erodes trust.
- **Tier accuracy**: cases whose tier matched `expected.tier`. Every Appendix A incident was a tiering failure, so a
  wrong tier is the first thing to fix.
- **Per tier**: recall per tier and how many misses were auto-passed by triage (no reviewer saw them).
- **Per lens / per model**: how often a lens or model was seated on incidents, how many incidents it caught with the
  *expected* class (blocking for the wrong reason does not count), and how often it raised a blocker on a clean case
  that blocked. Use this to choose models on evidence rather than brand.
- **Cost and duration**: per-case and total USD from the verdicts, p50/p95 wall time.
- Case reasons say exactly which check failed (`expected tier 3, got tier 1 (score 12 is below t1 (20): tier 0)`,
  `blocked for the wrong reason: no finding with class in [missing-flag] (raised: style@x.ts)`).

## Loosening policy with evidence

`evaluateBreakers(result, { maxFalseBlock?, minRecall?, minIncidentsPerTier? })` is the circuit-breaker hook. It is
pure and only suggests; it never edits a policy.

- False-block rate above threshold: `widenTriage` (raise `triage.maxLines` / `maxFiles`, add docs or asset patterns).
- Incident recall below threshold at a tier: `raiseQuorumTier` (and `raiseQuorumTiers`) for `quorum.t<n>`.
- Misses that triage auto-passed: `narrowTriage`, because more quorum cannot help a change no reviewer sees.

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
| `post-approval-auth-change` | regression | block, tier 3 | tiny post-approval auth change: 30-day sessions and MFA skip (`authn-bypass`) |
| `small-bugfix-with-test` | clean | pass, tier 0, review | refund formatting fix with tests, just over the triage limit |
| `docs-readme-edit` | clean | pass, tier 0, auto-pass | docs only |
| `lockfile-only-bump` | clean | pass, tier 0, auto-pass | lockfile only |

`starter.test.ts` runs it in dry mode against the real core stages on every test run.
