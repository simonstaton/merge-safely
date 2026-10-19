# Policy reference

Policy lives in `.merge-safely.yml` at the root of the repository under review. Every field has a conservative default, so an empty file (or no file) is valid.

The source of truth is [`packages/core/src/policy/schema.ts`](../packages/core/src/policy/schema.ts). This page is written from it.

## How a policy is read

- The file is parsed and validated, and defaults are filled in.
- **Unknown top-level keys are an error.** `tier:` instead of `tiers:` fails.
- **Unknown keys inside a section are dropped silently.** `tiers.criticalPath` (missing `s`) is ignored and the default critical paths stay in force. Run `merge-safely policy lint` and read its output.
- **Arrays and maps replace the default; they do not extend it.** Setting `tiers.criticalPaths` replaces the whole default list. To add patterns, copy the defaults (listed below) and append.
- **A panel tier you set replaces that tier's default.** Omitted fields take the generic defaults (`judges: 1`, `secondJudgeRound: false`), not the shipped tier's values. If you set `panel.t3: { hunters: [...] }`, t3 now has one judge and no second judge round unless you say otherwise.
- **The policy is hashed.** The hash (first 16 hex characters of a SHA-256 over the parsed policy with keys sorted) is stored on every verdict as `policyHash`. Reformatting or reordering keys does not change it. Any value change does, including a changed default after an upgrade.
- `.merge-safely.yml` is in the default critical paths, so any PR that edits the policy is reviewed at tier 3.

## Glob patterns

Path patterns are used by `tiers.criticalPaths`, `tiers.ignorePaths`, the `triage.*Patterns` lists and `panel.conditionalLenses`.

| Syntax | Matches |
|---|---|
| `**` | Zero or more whole path segments. |
| `*` | Any run of characters within one segment. Never crosses `/`. |
| `?` | One character within a segment. |
| `{a,b}` | Either alternative. |
| anything else | Literal. |

- Matching works on **whole path segments**. `**/auth/**` matches `src/auth/session.ts` but not `src/author/profile.ts`.
- Matching is **case-insensitive**.
- Patterns are anchored at the repository root. `*.tsx` matches only files at the root. Use `**/*.tsx` for "anywhere".
- For a rename, the previous path is checked too.

## Tiers and the score

Each change gets a score from 0 to 100 built from lines changed, files changed, module spread and, when an adapter supplies it, blast radius. The score maps to a level using `tiers.thresholds`:

| Level | Name | When |
|---|---|---|
| 0 | trivial | score below `t1` |
| 1 | standard | score at or above `t1` |
| 2 | elevated | score at or above `t2` |
| 3 | critical | score at or above `t3`, **or** any critical-path hit, **or** a removed feature-flag read when `flagRemovalIsCritical` |

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

A tier 0 change is auto-passed when it is docs-only, assets-only or lockfile-only (each when enabled), or when it is under both size limits with no critical-path hit.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `triage.maxLines` | integer ≥ 0 | `30` | Lines changed (additions plus deletions) under which a tier 0 change may auto-pass. |
| `triage.maxFiles` | integer ≥ 0 | `3` | Files changed under which a tier 0 change may auto-pass. |
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

Which lenses are seated as hunters at each tier, and how many judges vote on their findings. A tier 0 change that is not triaged uses `t1`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `panel.t1.hunters` | lens id[] (at least 1) | `[correctness, repro]` | Hunter lenses at tier 1. |
| `panel.t1.judges` | integer 0–5 | `1` | Judge seats at tier 1. |
| `panel.t1.secondJudgeRound` | boolean | `false` | Run a second judge round at tier 1. |
| `panel.t2.hunters` | lens id[] | `[intent, correctness, repro, design-fidelity]` | Hunter lenses at tier 2. |
| `panel.t2.judges` | integer 0–5 | `2` | Judge seats at tier 2. |
| `panel.t2.secondJudgeRound` | boolean | `false` | |
| `panel.t3.hunters` | lens id[] | `[intent, correctness, repro, security, perf, rollout, blast-radius]` | Hunter lenses at tier 3. |
| `panel.t3.judges` | integer 0–5 | `2` | Judge seats at tier 3. |
| `panel.t3.secondJudgeRound` | boolean | `true` | Run a second judge round at tier 3. Findings that judges raise themselves need a second judge to confirm them. |
| `panel.conditionalLenses` | map of lens id → glob[] | see below | A lens listed here is seated only when a changed path matches one of its globs. |

When you set a tier, omitted fields default to `judges: 1` and `secondJudgeRound: false`.

Shipped lens ids: `intent`, `correctness`, `repro`, `blast-radius`, `perf`, `security`, `design-fidelity`, `rollout`. Third-party lenses registered at startup can be used by id. See [lenses.md](lenses.md).

Default `conditionalLenses`:

```yaml
design-fidelity: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss", "**/components/**", "**/ui/**"]
```

## `models`

Which connection and model each seat uses. Connection ids refer to connections in your connections file, the Action's `connections` input, or the App's setup page. See [connections.md](connections.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `models.hunters` | `{ connection, model, effort? }` | automatic | Model for hunter seats. |
| `models.judges` | `{ connection, model, effort? }` | automatic | Model for judge seats. |
| `models.fallback` | `{ connection, model, effort? }` | none | Used when a seat's primary is rate limited or down. Fallback use is recorded on the verdict. |
| `models.decorrelate` | boolean | `true` | With more than one reachable connection, alternate hunter seats across connections, and prefer a judge connection other than the one serving most hunters. |
| `models.perLens` | map of lens id → `{ connection, model, effort? }` | `{}` | Per-lens override, for example a stronger model for `security`. |

`effort` is passed to the provider as a reasoning or thinking level when the model supports it.

Selection order for each seat: `models.perLens[lens]`, then `models.hunters` or `models.judges`, then automatic.

Automatic selection:

- Hunters take the first `mid`-tier model of the hunter connection, then `frontier`, then `small`.
- Judges take the strongest tier available across all reachable connections. A judge is never weaker than the best model on offer, and so never weaker than any hunter.

A policy that names a connection the installation does not have, or a model a connection cannot reach, fails seating loudly with a fix hint. It never silently runs a weaker panel.

## `quorum`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `quorum.t1` | integer ≥ 1 | `1` | Passing seats required at tier 1. |
| `quorum.t2` | integer ≥ 1 | `2` | Passing seats required at tier 2. |
| `quorum.t3` | integer ≥ 2 | `2` | Passing seats required at tier 3. Cannot be set below 2. |
| `quorum.judgeAgreement` | number 0–1 | `0.6` | Fraction of judges that must confirm a finding for it to survive. |
| `quorum.dropClasses` | string[] | `[style, formatting, naming-preference, comment-style, whitespace]` | Finding classes dropped in the judge phase. |

One surviving `blocker` blocks the change regardless of quorum. Seats that time out, error, return invalid output, exceed budget or fail proof of work do not count as passes.

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
| `rounds.max` | integer ≥ 1 | `3` | Review rounds per PR before escalating to a human. |
| `rounds.diffOnlyAfterRound` | integer ≥ 0 | `1` | After this round, reviewers get only the delta since the last reviewed SHA. |
| `rounds.neverRepeatFindings` | boolean | `true` | Reviewers are given earlier findings as known, must not repeat them, and must check whether each was addressed. |

## `trust`

Trust never changes the tier. It decides who may bypass and where escalations go.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `trust.provider` | `none` \| `github-teams` \| `allowlist` \| `codeowners` | `none` | How authors are classified. `github-teams` needs organisation members read access (the App, not the Action's default token). |
| `trust.trusted` | string[] | `[]` | Trusted principals: `org/team` slugs for `github-teams`, logins for `allowlist`. |
| `trust.blocked` | string[] | `[]` | Principals classified as blocked. |
| `trust.trustedBypassMaxTier` | integer 0–3 | `2` | Highest tier at which trusted authors may bypass. Mirror it with bypass actors in your ruleset. |
| `trust.escalateTier3ForStandardAuthors` | boolean | `true` | At tier 3, a non-trusted author's PR is escalated to a human after AI review. |
| `trust.botsAreStandard` | boolean | `true` | Bot and agent principals are never trusted, whatever the allowlist says. |

A reviewer may never be the same principal as the author.

## `reporting`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `reporting.checkName` | string | `merge-safely/verdict` | Name of the check run. This is what you make required. |
| `reporting.postPrReview` | boolean | `true` | Post a PR review with the digest. |
| `reporting.inlineComments` | boolean | `true` | Post findings as inline review comments on the lines they refer to. |
| `reporting.showCostInSummary` | boolean | `true` | End the summary with the cost line. |
| `reporting.requestChangesOnBlock` | boolean | `true` | On block, the PR review requests changes. `false` makes every review comment-only. |

## `budget`

See [budgets.md](budgets.md) for how ceilings, alerts and the downgrade ladder work.

For the dollar ceilings: `null` means never configured, `0` means explicitly disabled. Neither ever blocks.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `budget.perSeatUsd` | number ≥ 0 | `5` | Dollar cap for one reviewer run. `0` disables the dollar cap; turns and deadline still apply. |
| `budget.perChangeUsd` | number ≥ 0 | `25` | Dollar cap for one PR across all rounds. |
| `budget.perInstallationMonthlyUsd` | number ≥ 0 or `null` | `null` | Calendar-month cap for the installation. Enforced by the App; advisory in the Action. |
| `budget.windowUsd` | number ≥ 0 or `null` | `null` | Cap for the installation over a rolling window. |
| `budget.windowDays` | number 0–7 | `7` | Length of the rolling window. |
| `budget.spendLimitUsd` | number ≥ 0 or `null` | `null` | All-time cap for the installation, against the gate's own ledger. |
| `budget.onOverBudget` | `downgrade-then-block` \| `block` | `downgrade-then-block` | What to do when a panel would breach a ceiling. |
| `budget.seatMaxTurns` | integer ≥ 1 | `50` | Model turns per seat. |
| `budget.seatDeadlineMs` | integer ≥ 1000 | `600000` (10 min) | Wall-clock deadline per seat. |
| `budget.alertThresholds` | number[] (0–2) | `[0.5, 0.8, 1.0]` | Fractions of a ceiling at which an alert fires, once per upward crossing. |

## `runner`

What reviewers may do in the workspace. See [security.md](security.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `runner.allowedCommands` | string[] | `[]` | Commands reviewers may execute. Empty means read-only tools only. |
| `runner.commandTimeoutMs` | integer ≥ 1000 | `300000` (5 min) | Timeout per command. |
| `runner.maxToolOutputBytes` | integer ≥ 1024 | `65536` | Tool output beyond this is truncated before it reaches the model. |
| `runner.redactSecrets` | boolean | `true` | Redact secret-looking strings from diffs and untrusted text before prompting. |

### `allowedCommands` semantics

- **Exact match by default.** `"npm test"` allows exactly `npm test` and nothing else: not `npm test -- --watch`, not `npm test; curl …`.
- **A trailing ` *` allows extra arguments after the prefix.** `"npx vitest run *"` allows `npx vitest run`, `npx vitest run src/foo.test.ts`, and so on. The space before `*` matters.
- The Claude Code CLI runner also rejects, with a warning, any entry that contains shell metacharacters, is a bare interpreter or shell (`node`, `python3`, `bash`, `env`, `find`, `xargs` and similar), or is raw `git`.

**An allowed command executes the PR's code.** A test runner runs whatever the PR put in the tests, the config and the dependencies. Only allow commands when the gate runs in a container or sandbox you are willing to let PR authors execute code in. Never allow them for fork PRs. See [security.md](security.md#what-allowedcommands-exposes).

## Example policies

Three complete files are in [examples/policies/](../examples/policies/). All three validate against the schema.

The library and UI examples replace the default critical paths with a shorter list. Whatever list you write, keep the CI workflow, agent configuration and policy file entries in it.

### Strict monorepo

[examples/policies/strict.yml](../examples/policies/strict.yml). Lower thresholds, the full default critical path list extended with repo-specific paths, bigger panels, three judges at tier 3, a stronger model for the security lens, team trust with bypass only at tier 1, an installation budget, and `onOverBudget: block` so a cheaper panel never runs silently.

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
