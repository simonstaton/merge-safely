# Policy reference

Policy lives in `.merge-safely.yml` at the root of the repository under review. Every field has a conservative default, so an empty file (or no file) is valid. `merge-safely policy init` writes a commented starter file with every default.

The source of truth is [`packages/core/src/policy/schema.ts`](../packages/core/src/policy/schema.ts). Every key below is read from it.

## How a policy is read

- **It comes from the base branch.** The Action, the App and `merge-safely run --repo … --pr …` read `.merge-safely.yml` from the PR's base branch, never from the PR head, so a PR cannot loosen its own review. `run --local` reads the file in your working tree.
- The file is parsed and validated, and defaults are filled in. An invalid policy fails the review with the errors and calls no model.
- **Unknown keys are an error at every level.** `tier:` instead of `tiers:` fails, and so does `tiers.criticalPath` (missing `s`) or an extra key inside `models.hunters`. The only open maps are `panel.conditionalLenses` and `models.perLens`, whose keys are lens ids. Run `merge-safely policy lint` in CI.
- **Arrays and maps replace the default; they do not extend it.** Setting `tiers.criticalPaths` replaces the whole default list. To add patterns, copy the defaults (listed below) and append.
- **A panel tier you set replaces that tier's default.** Omitted fields take the generic defaults (`judges: 1`, `secondJudgeRound: false`), not the shipped tier's values. If you set `panel.t3: { hunters: [...] }`, t3 now has one judge and no second judge round unless you say otherwise.
- **The policy is hashed.** The hash (first 16 hex characters of a SHA-256 over the parsed policy with keys sorted) is stored on every verdict as `policyHash`. Reformatting or reordering keys does not change it. Any value change does, including a changed default after an upgrade.
- `.merge-safely.yml` is in the default critical paths, so any PR that edits the policy is reviewed at tier 3.

## Glob patterns

Path patterns are used by `tiers.criticalPaths`, `tiers.ignorePaths`, the `triage.*Patterns` lists and `panel.conditionalLenses`. Every list uses the same matcher, so a pattern means the same thing everywhere.

| Syntax | Matches |
|---|---|
| `**` | As a whole segment: zero or more path segments. A trailing `/**` needs at least one more segment. |
| `*` | Any run of characters within one segment. Never crosses `/`. (`a**b` inside a segment is the same as `a*b`.) |
| `?` | One character within a segment. |
| `{a,b}` | Either alternative, within one segment. Alternatives may use `*` and `?`. |
| anything else | Literal. |

- Matching works on **whole path segments**, never substrings. `**/auth/**` matches `src/auth/session.ts` but not `src/author/profile.ts`.
- Matching is **case-insensitive**: `**/components/**` matches `src/Components/Button.tsx`.
- A pattern with a `/` is anchored at the repository root (`src/**/*.tsx`). A pattern without one matches the file name at any depth, so `*.tsx` behaves like `**/*.tsx`.
- **A trailing `/**` means "inside this directory".** `**/dist/**` matches `dist/a.js` but not a file named `dist`, and `src/design-system/**` matches files inside that directory but not the path `src/design-system` itself.
- A trailing `/` means a directory: `docs/` behaves like `**/docs/**`, `site/docs/` like `site/docs/**`.
- A leading `./` or `/` is ignored.
- For a rename, the previous path is checked too: moving a file out of a critical directory is still a critical-path hit.

## Tiers and the score

Each change gets a score from 0 to 100. Files matching `tiers.ignorePaths` are left out of the size terms:

```
score = round(min(100,
    45 * loc / (loc + 300)                    lines added + deleted
  + 20 * files / (files + 15)                 files changed
  + 20 * (modules - 1) / ((modules - 1) + 4)  module spread: distinct first-two directory segments
  + 10 if any critical path is hit
  +  5 if any feature-flag read is removed))
```

Each term saturates and never decreases, so adding lines, files or modules never lowers the score. Roughly: 30 lines in 3 files in one module scores about 7 (tier 0), 200 lines in 8 files across 3 modules about 32 (tier 1), 800 lines in 25 files across 5 modules about 55 (tier 2). Only very large, sprawling changes reach 80 on size alone.

The score maps to a level using `tiers.thresholds`:

| Level | Name | When |
|---|---|---|
| 0 | trivial | score below `t1` |
| 1 | standard | score at or above `t1` |
| 2 | elevated | score at or above `t2` |
| 3 | critical | score at or above `t3`, **or** any critical-path hit, **or** a removed feature-flag read when `flagRemovalIsCritical`, **or** a file list the source truncated (files that cannot be seen may be critical) |

A feature-flag read counts as removed when a removed line matches `tiers.flagReadPatterns` and the same call does not reappear in the file's added lines (a moved or reformatted call is not a removal). Calls split across lines are matched whole.

The author never sets the tier. Trust affects only bypass and escalation.

## `version`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | `1` | Schema version. Only `1` is accepted. |

## `tiers`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tiers.thresholds.t1` | number 0–100 | `20` | Score at which a change becomes tier 1. |
| `tiers.thresholds.t2` | number 0–100 | `50` | Score at which a change becomes tier 2. |
| `tiers.thresholds.t3` | number 0–100 | `80` | Score at which a change becomes tier 3. |
| `tiers.criticalPaths` | glob[] | see below | Any changed path matching one of these forces tier 3. |
| `tiers.flagRemovalIsCritical` | boolean | `true` | A diff whose removed lines contain a feature-flag read is tier 3. |
| `tiers.flagReadPatterns` | regex[] | see below | Regular expressions (JavaScript source form) that identify a feature-flag read in removed lines. |
| `tiers.ignorePaths` | glob[] | see below | Paths excluded from size scoring: generated code, vendored code, lockfiles, snapshots. |

Default `criticalPaths`:

```yaml
- "**/migrations/**"
- "**/migration/**"
- "**/schema.prisma"
- "**/*.sql"
- "**/jobs/**/backfill*"
- "**/backfill*/**"
- "**/queries/**/*Raw.*"
- "**/auth/**"
- "**/authz/**"
- "**/permissions/**"
- "**/payments/**"
- "**/billing/**"
- "**/payouts/**"
- "**/webhooks/**"
- "**/crypto/**"
- "**/secrets/**"
- ".github/workflows/**"
- ".github/actions/**"
- ".claude/**"
- ".cursor/**"
- ".codex/**"
- "**/CLAUDE.md"
- "**/AGENTS.md"
- ".merge-safely.yml"
- "**/Dockerfile"
- "**/docker-compose*.yml"
- "**/infra/**"
- "**/terraform/**"
- "**/*.tf"
- "**/layouts/**"
```

They cover data changes (migrations, schema, raw SQL, backfills), money and identity (auth, permissions, payments, billing, payouts, webhooks, crypto, secrets), the delivery pipeline (CI workflows, Docker, infrastructure), agent configuration (`.claude/`, `.cursor/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, this policy file), and shared layouts.

Agent configuration is critical because it changes what coding agents do in the repository, and it can carry instructions aimed at reviewers.

Default `flagReadPatterns`:

```yaml
- "\\b(isEnabled|isFeatureEnabled|useFlag|useFeatureFlag|getFlag|featureFlag|flags?\\.(get|is)\\w*|unleash\\.isEnabled|posthog\\.isFeatureEnabled|ldClient\\.variation)\\s*\\("
```

Default `ignorePaths`:

```yaml
- "**/package-lock.json"
- "**/pnpm-lock.yaml"
- "**/yarn.lock"
- "**/*.snap"
- "**/dist/**"
- "**/vendor/**"
- "**/generated/**"
```

## `triage`

Triage applies only to tier 0 changes. It is deterministic: no model is called. A triaged change gets a verdict with zero seats and `triaged: true`.

A tier 0 change is auto-passed when every changed path (and every previous path of a rename) is documentation, a static asset or a lockfile (each when enabled), or when it changes at most `maxLines` lines in at most `maxFiles` files. It is never auto-passed when:

- it lists no files, or the source truncated the file list;
- it hits a critical path or removes a feature-flag read (which already makes it tier 3);
- a file shows no line changes and no patch (a binary, mode or symlink change) and is not a recognised asset;
- an earlier round left a blocker or important finding open on the PR.

Size here counts every file, including `tiers.ignorePaths`: ignore paths are a scoring aid, not a triage exemption. Draft status never changes triage.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `triage.maxLines` | integer ≥ 0 | `30` | A tier 0 change of at most this many lines (additions plus deletions) may auto-pass. `0` turns size-based auto-pass off for any change with lines. |
| `triage.maxFiles` | integer ≥ 0 | `3` | A tier 0 change of at most this many files may auto-pass. |
| `triage.docsOnlyAutoPass` | boolean | `true` | Auto-pass when every changed path matches `docsPatterns`. |
| `triage.assetsOnlyAutoPass` | boolean | `true` | Auto-pass when every changed path matches `assetPatterns`. |
| `triage.lockfileOnlyAutoPass` | boolean | `true` | Auto-pass when every changed path matches `lockfilePatterns`. |
| `triage.docsPatterns` | glob[] | see below | What counts as documentation. |
| `triage.assetPatterns` | glob[] | see below | What counts as a static asset. |
| `triage.lockfilePatterns` | glob[] | see below | What counts as a lockfile. |

Defaults:

```yaml
docsPatterns:     ["**/*.md", "**/*.mdx", "**/*.rst", "docs/**", "**/LICENSE", "**/LICENSE.*", "**/CHANGELOG.md", "**/README*"]
assetPatterns:    ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.svg", "**/*.webp", "**/*.ico", "**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.mp4"]
lockfilePatterns: ["**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/Cargo.lock", "**/poetry.lock", "**/go.sum"]
```

A critical-path hit always makes a change tier 3, so `**/CLAUDE.md` and `**/AGENTS.md` are never auto-passed as docs.

## `panel`

Which lenses are seated as hunters at each tier, and how many judges vote on their findings. Each listed lens is one hunter seat. A tier 0 change that is not triaged uses `t1`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `panel.t1.hunters` | lens id[] (at least 1) | `[correctness, repro]` | Hunter lenses at tier 1. |
| `panel.t1.judges` | integer 0–5 | `1` | Judge seats at tier 1. `0` runs no judge phase: hunter findings stand unverified (the digest says "unjudged"). |
| `panel.t1.secondJudgeRound` | boolean | `false` | Run a second judge round at tier 1 (see t3). |
| `panel.t2.hunters` | lens id[] | `[intent, correctness, repro, design-fidelity]` | Hunter lenses at tier 2. |
| `panel.t2.judges` | integer 0–5 | `2` | Judge seats at tier 2. |
| `panel.t2.secondJudgeRound` | boolean | `false` | Run a second judge round at tier 2. |
| `panel.t3.hunters` | lens id[] | `[intent, correctness, repro, security, perf, rollout, blast-radius]` | Hunter lenses at tier 3. |
| `panel.t3.judges` | integer 0–5 | `2` | Judge seats at tier 3. |
| `panel.t3.secondJudgeRound` | boolean | `true` | Findings the judges split on (at least one confirm or downgrade and at least one refute) go back to every judge for a second vote, which becomes each judge's vote of record. |
| `panel.conditionalLenses` | map of lens id → glob[] | see below | A lens listed here is seated only when a changed path matches one of its globs. |

When you set a tier, omitted fields default to `judges: 1` and `secondJudgeRound: false`. `hunters` must list at least one lens.

Shipped lens ids: `intent`, `correctness`, `repro`, `blast-radius`, `perf`, `security`, `design-fidelity`, `rollout`. Third-party lenses registered at startup can be used by id; `policy lint` warns about an id it does not know. See [lenses.md](lenses.md).

Default `conditionalLenses`:

```yaml
design-fidelity: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss", "**/components/**", "**/ui/**"]
```

A conditional lens is seated when any changed path, or the previous path of a rename, matches one of its globs (see [Glob patterns](#glob-patterns)). For example, `**/ui/**` matches `src/UI/button.tsx` but not a file named `ui`, and `**/*.{tsx,jsx}` matches either extension. Setting `conditionalLenses` replaces the default map, so repeat the `design-fidelity` entry if you still want it.

## `models`

Which connection and model each seat uses. Connection ids refer to connections in your connections file, the Action's `connections` input, or the App's setup page. See [connections.md](connections.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `models.hunters` | `{ connection, model, effort? }` | automatic | Model for hunter seats. |
| `models.judges` | `{ connection, model, effort? }` | automatic | Model for judge seats. |
| `models.fallback` | `{ connection, model, effort? }` | none | Used when a seat's primary is rate limited or down, if the fallback still fits the budget. Fallback use is recorded on the seat's run and in the cost breakdown. |
| `models.decorrelate` | boolean | `true` | With more than one reachable connection, alternate hunter seats across connections, and prefer a judge connection other than the one serving most hunters. |
| `models.perLens` | map of lens id → `{ connection, model, effort? }` | `{}` | Per-lens override, for example a stronger model for `security`. |

`effort` is passed to the provider as a reasoning or thinking level when the model supports it.

Each selection object takes exactly `connection`, `model` and optionally `effort`; any other key is an error.

Selection order for each seat: `models.perLens[lens]`, then `models.hunters` or `models.judges`, then automatic.

Automatic selection:

- Hunters take the first `mid`-tier model of the hunter connection, then `frontier`, then `small`. Within a tier the catalog's order is the preference (the registry lists recommended models first).
- Judges take the strongest tier available across all reachable connections. A judge is never weaker than the best model on offer, and so never weaker than any hunter.
- With `decorrelate` and more than one reachable connection, hunter seats (other than per-lens overrides) alternate round-robin across connections, and automatic judges prefer an equally strong connection other than the one serving most hunters.

Model ids are compared loosely (case, `[1m]` suffixes, vendor prefixes and date suffixes are ignored). A connection with no models endpoint is trusted with a warning.

A policy that names a connection the installation does not have, or a model a connection cannot reach, fails seating loudly (`error [SEATING]`) with a fix hint. It never silently runs a weaker panel. The CLI also refuses to run when a connection the policy names fails validation.

## `quorum`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `quorum.t1` | integer ≥ 1 | `1` | Valid hunter passes required at tier 1 (and for a tier 0 change that was not triaged, which always needs 1). |
| `quorum.t2` | integer ≥ 1 | `2` | Passing seats required at tier 2. |
| `quorum.t3` | integer ≥ 2 | `2` | Passing seats required at tier 3. Cannot be set below 2. |
| `quorum.judgeAgreement` | number 0–1 | `0.6` | Fraction of counted judges whose vote is confirm or downgrade for a finding to survive. A judge that does not vote on a finding counts as not agreeing. |
| `quorum.dropClasses` | string[] | `[style, formatting, naming-preference, comment-style, whitespace]` | Finding classes dropped outright, judged or not. Matched case-insensitively. |

How a round is decided:

- **Block** when a `blocker` survives the judges, when a hunter's block is upheld (at least one of its findings survives at `blocker` or `important`), or when a `blocker` or `important` finding from an earlier round is still open.
- **Pass** when the valid hunter passes reach the tier's quorum.
- **Pending** otherwise, for example when too many seats timed out, errored, returned invalid output, exceeded their budget or failed proof of work. None of those count as passes.

A downgrade vote lowers a surviving finding to the lowest severity the judges gave (one step down when they gave none). A finding a judge raises itself survives when two judges raise it, or when only one judge counted, and is then capped at `important`.

## `proofOfWork`

A pass must be earned. The runner counts what the reviewer actually did; the model cannot report it.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `proofOfWork.minSubstantiveCalls` | integer ≥ 0 | `3` | Minimum substantive tool calls (reads, greps, diffs, test runs) for a pass to count. |
| `proofOfWork.requireFilesRead` | boolean | `true` | A pass with no files read does not count. |

A pass that fails proof of work is excluded from quorum. A block is never discarded for lack of work; it goes to the judges.

## `rounds`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rounds.max` | integer ≥ 1 | `3` | Distinct commits reviewed by a panel before the PR goes to a human. Triaged, pending and contested results, and re-runs of the same commit, do not use up a round. Once the cap is reached, the next commit is not reviewed: it keeps any open blocker as a block (otherwise it is pending) and is escalated. |
| `rounds.diffOnlyAfterRound` | integer ≥ 0 | `1` | Rounds after this one review only the delta since the last reviewed commit, when that commit's review actually reached a model. Otherwise the round reviews the full diff from the base. |
| `rounds.neverRepeatFindings` | boolean | `true` | Accepted, but currently has no effect: reviewers are always given the open findings from earlier rounds as known, told not to repeat them, and asked whether each was addressed. |

A known finding counts as addressed only when no hunter raised it again and an attested hunter says it was addressed; for a `blocker` or `important` finding, a strict majority of attested hunters must say so. Everything else is carried into the verdict and keeps blocking. A human `pass` clears every open finding.

## `trust`

Trust never changes the tier. It decides who may bypass and where escalations go.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `trust.provider` | `none` \| `github-teams` \| `allowlist` \| `codeowners` | `none` | How authors are classified. `allowlist` matches logins. `github-teams` also matches `org/team` slugs and needs organisation members read access (the App with Members: Read, not the Action's default token); a lookup error classifies the author as standard. `codeowners` is accepted but is not implemented yet: it behaves like `none`. |
| `trust.trusted` | string[] | `[]` | Trusted principals: logins (`alice` or `@alice`), or `org/team` slugs with `github-teams`. Ignored with `none` and `codeowners`. |
| `trust.blocked` | string[] | `[]` | Principals classified as blocked. Applies with every provider, and wins over `trusted`. |
| `trust.trustedBypassMaxTier` | integer 0–3 | `2` | Highest tier at which a trusted author's PR takes the light path: still fully reviewed, never escalated. Mirror it with bypass actors in your ruleset. |
| `trust.escalateTier3ForStandardAuthors` | boolean | `true` | When a non-trusted author's tier 3 change blocks, escalate it to a human. |
| `trust.botsAreStandard` | boolean | `true` | Bot and agent principals are never trusted, whatever the allowlist says. |

A blocked author's change is escalated whenever it does not pass. A review that cannot decide (pending) is escalated too. Escalation needs an escalation adapter (Slack in the CLI, Action and App) and happens once per commit.

## `reporting`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `reporting.checkName` | string | `merge-safely/verdict` | Name of the check run (or commit status). This is what you make required. |
| `reporting.postPrReview` | boolean | `true` | Post a PR review with the digest. Never an `APPROVE` review. |
| `reporting.inlineComments` | boolean | `true` | Post findings as inline review comments on the lines they refer to. |
| `reporting.showCostInSummary` | boolean | `true` | End the summary with the cost line. |
| `reporting.requestChangesOnBlock` | boolean | `true` | On block, the PR review requests changes (and a later pass dismisses it). `false` makes every review comment-only. |

## `budget`

See [budgets.md](budgets.md) for how ceilings, alerts and the downgrade ladder work.

For the dollar ceilings: `null` means never configured, `0` means explicitly disabled. Neither ever blocks.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `budget.perSeatUsd` | number ≥ 0 | `5` | Dollar cap for one reviewer run. `0` disables the dollar cap; turns and deadline still apply. |
| `budget.perChangeUsd` | number ≥ 0 | `25` | Dollar cap for one PR across all rounds. |
| `budget.perInstallationMonthlyUsd` | number ≥ 0 or `null` | `null` | Cap for the installation over the last 30 days. Enforced by the App; advisory (reported, never blocking) in the Action and the CLI. |
| `budget.windowUsd` | number ≥ 0 or `null` | `null` | Cap for the installation over a rolling window. |
| `budget.windowDays` | number 0–7 | `7` | Length of the rolling window in days. |
| `budget.spendLimitUsd` | number ≥ 0 or `null` | `null` | All-time cap for the installation, against the gate's own ledger. |
| `budget.onOverBudget` | `downgrade-then-block` \| `block` | `downgrade-then-block` | What to do when a panel would breach a ceiling: step down the downgrade ladder first, or refuse straight away. |
| `budget.seatMaxTurns` | integer ≥ 1 | `50` | Model turns per seat. |
| `budget.seatDeadlineMs` | integer ≥ 1000 | `600000` (10 min) | Wall-clock deadline per seat. |
| `budget.alertThresholds` | number[] (0–2) | `[0.5, 0.8, 1.0]` | Fractions of a ceiling at which the App alerts, once per upward crossing. |

## `runner`

What reviewers may do in the workspace. See [security.md](security.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `runner.allowedCommands` | string[] | `[]` | Commands reviewers may execute. Empty means read-only tools only. |
| `runner.commandTimeoutMs` | integer ≥ 1000 | `300000` (5 min) | Timeout per command; the whole process group is killed. |
| `runner.maxToolOutputBytes` | integer ≥ 1024 | `65536` | Tool output beyond this is truncated before it reaches the model. |
| `runner.redactSecrets` | boolean | `true` | Redact secret-looking strings (`[REDACTED:<kind>]`) from the PR title, body, commit messages, comments and diff before prompting. Tool output is always redacted. |

### `allowedCommands` semantics

- **Exact match by default.** `"npm test"` allows exactly `npm test` and nothing else: not `npm test -- --watch`, not `npm test; curl …`.
- **A trailing ` *` allows extra arguments after the prefix.** `"npx vitest run *"` allows `npx vitest run`, `npx vitest run src/foo.test.ts`, and so on. The space before `*` matters.
- Commands are tokenised without a shell. Any shell metacharacter in the requested command is rejected, even inside quotes.
- The command runs in the checkout with a scratch `HOME`, `XDG_*` and `TMPDIR`, and an environment reduced to safe `PATH` entries, `LANG`, `CI` and `NODE_ENV`.
- The Claude Code CLI runner also rejects, with a warning, any entry that contains shell metacharacters, is a bare interpreter or shell (`node`, `python3`, `bash`, `env`, `find`, `xargs` and similar), or is raw `git`.
- On a fork PR reviewed under `pull_request_target`, the Action ignores `allowedCommands` and logs a `SECURITY` warning.

**An allowed command executes the PR's code.** A test runner runs whatever the PR put in the tests, the config and the dependencies. Only allow commands when the gate runs in a container or sandbox you are willing to let PR authors execute code in. Never allow them for fork PRs. See [security.md](security.md#what-allowedcommands-exposes).

## Example policies

Three complete files are in [examples/policies/](../examples/policies/). All three pass `merge-safely policy lint` (the only warnings are for connection ids you have not made yet).

The library and UI examples replace the default critical paths with a shorter list. Whatever list you write, keep the CI workflow, agent configuration and policy file entries in it.

### Strict monorepo

[examples/policies/strict.yml](../examples/policies/strict.yml). Lower thresholds, the full default critical path list extended with repo-specific paths, bigger panels, three judges at tier 3, a stronger model for the security lens, team trust with bypass only at tier 1, installation budgets meant for the App (in the Action the window ceiling only sees the current job; see [budgets.md](budgets.md#semantics)), and `onOverBudget: block` so a cheaper panel never runs silently.

```yaml
version: 1
tiers:
  thresholds: { t1: 15, t2: 40, t3: 70 }
  criticalPaths:
    # ...the 30 defaults, copied...
    - "packages/shared-ui/**"
    - "services/*/src/routes/**"
    - "**/feature-flags/**"
    - "**/CODEOWNERS"
triage: { maxLines: 15, maxFiles: 2 }
panel:
  t1: { hunters: [correctness, repro, security], judges: 1 }
  t2: { hunters: [intent, correctness, repro, security, blast-radius, design-fidelity], judges: 2 }
  t3: { hunters: [intent, correctness, repro, security, perf, rollout, blast-radius], judges: 3, secondJudgeRound: true }
models:
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }
  perLens:
    security: { connection: anthropic-main, model: claude-opus-5-5 }
quorum: { t1: 2, t2: 3, t3: 3, judgeAgreement: 0.67 }
proofOfWork: { minSubstantiveCalls: 5 }
trust:
  provider: github-teams
  trusted: ["my-org/platform"]
  trustedBypassMaxTier: 1
budget:
  perChangeUsd: 40
  perInstallationMonthlyUsd: 1500
  windowUsd: 600
  onOverBudget: block
runner:
  allowedCommands: ["npm test", "npx vitest run *"]
```

### Small library

[examples/policies/library.yml](../examples/policies/library.yml). The risk in a library is its public API and its release pipeline, so the critical paths are the entry point, `package.json`, workflows and release scripts. Small panels, one judge, small budgets, a single trusted maintainer.

```yaml
version: 1
tiers:
  criticalPaths:
    - "src/index.ts"
    - "package.json"
    - ".github/workflows/**"
    - ".github/actions/**"
    - ".merge-safely.yml"
    - ".claude/**"
    - ".cursor/**"
    - ".codex/**"
    - "**/CLAUDE.md"
    - "**/AGENTS.md"
    - "scripts/release*"
panel:
  t1: { hunters: [correctness], judges: 1 }
  t2: { hunters: [correctness, repro, blast-radius], judges: 1 }
  t3: { hunters: [intent, correctness, repro, security, blast-radius], judges: 2 }
models:
  hunters: { connection: openai-main, model: gpt-5-mini }
  judges:  { connection: openai-main, model: gpt-5 }
quorum: { t1: 1, t2: 1, t3: 2 }
trust: { provider: allowlist, trusted: ["my-handle"], trustedBypassMaxTier: 2 }
budget: { perSeatUsd: 2, perChangeUsd: 8 }
```

### UI application

[examples/policies/ui-app.yml](../examples/policies/ui-app.yml). Layouts, routes and design tokens are critical because one change reaches every page. `design-fidelity` is seated at every tier but only when UI files change. Hunters and judges on different providers.

```yaml
version: 1
tiers:
  criticalPaths:
    - "src/layouts/**"
    - "src/app/routes/**"
    - "src/design-system/tokens/**"
    - "src/auth/**"
    - "**/payments/**"
    - "**/feature-flags/**"
    - ".github/workflows/**"
    - ".merge-safely.yml"
    - ".claude/**"
    - ".cursor/**"
    - ".codex/**"
    - "**/CLAUDE.md"
    - "**/AGENTS.md"
  ignorePaths: ["**/package-lock.json", "**/*.snap", "**/dist/**", "**/generated/**", "public/locales/**"]
panel:
  t1: { hunters: [correctness, design-fidelity], judges: 1 }
  t2: { hunters: [intent, correctness, design-fidelity, blast-radius, perf], judges: 2 }
  t3: { hunters: [intent, correctness, repro, security, perf, rollout, blast-radius, design-fidelity], judges: 2, secondJudgeRound: true }
  conditionalLenses:
    design-fidelity: ["src/**/*.tsx", "src/**/*.css", "src/design-system/**"]
models:
  hunters: { connection: gemini-main, model: gemini-3.5-flash }
  judges:  { connection: anthropic-main, model: claude-opus-5-5 }
budget: { perChangeUsd: 15 }
runner:
  allowedCommands: ["npm run typecheck", "npx vitest run *"]
```
