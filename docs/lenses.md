# Lenses and personas

A **lens** is one question a reviewer answers, a checklist that tells the reviewer how to investigate it, and the finding classes it typically emits. Policy picks which lenses run at each tier (`panel.t1.hunters`, `t2`, `t3`). Each listed lens becomes one hunter seat. The defaults are `correctness` and `repro` at tier 1, `intent`, `correctness`, `repro` and `design-fidelity` at tier 2, and `intent`, `correctness`, `repro`, `security`, `perf`, `rollout` and `blast-radius` at tier 3 (see [policy.md](policy.md#panel)).

The shared rubric (severities, evidence, verdict rules, untrusted-text handling) is the same for every lens and is added by the prompt builder. A lens only describes what is specific to it.

## Shipped lenses

| Lens | Question | Classes | Preferred model tier |
|---|---|---|---|
| `intent` | Does the change solve the problem in the linked ticket or description, at the right layer, the way a senior engineer would have built it, or is it a symptom fix? | `symptom-fix`, `scope-creep`, `wrong-layer`, `misread-requirement`, `incomplete-fix`, `reinvented-utility` | frontier |
| `correctness` | Does the code do what it says? Edge cases, nulls, concurrency, error paths. | `logic-error`, `unhandled-case`, `null-handling`, `race`, `error-path`, `resource-leak`, `off-by-one` | frontier |
| `repro` | Can the claimed behaviour be reproduced? Run the tests, exercise the path, measure. | `unverified-claim`, `failing-path`, `test-gap`, `vacuous-test`, `flaky-test` | mid |
| `blast-radius` | What else consumes this? Shared components, routes, callers, schema readers. | `breaking-consumer`, `silent-prop-drop`, `api-contract`, `schema-reader-break`, `route-break`, `event-contract` | mid |
| `perf` | Query counts, N+1, locks, signatures per request, bundle size. | `n-plus-one`, `lock-risk`, `unbounded-scan`, `missing-index`, `unbounded-memory`, `blocking-io`, `per-request-overhead`, `bundle-bloat` | mid |
| `security` | Authz, injection, secrets, SSRF, permission widening. | `authz-gap`, `authn-bypass`, `injection`, `secret-exposure`, `ssrf`, `path-traversal`, `permission-widening`, `unsafe-deserialization`, `sensitive-data-leak`, `review-manipulation` | frontier |
| `design-fidelity` | For UI: does it match the referenced design, tokens, accessibility, RTL and reduced motion? Conditional. | `a11y`, `token-drift`, `layout-regression`, `design-mismatch`, `rtl-break`, `motion-sensitivity`, `missing-state` | mid |
| `rollout` | Flags, migrations, backfills, data volume, rollback path. Does the flag exist in production? | `missing-flag`, `unflagged-enable`, `flag-default-on`, `unbatched-backfill`, `irreversible-migration`, `blocking-migration`, `deploy-order`, `no-rollback` | mid |

`design-fidelity` is conditional: by default it is seated only when the change touches UI-looking paths (`panel.conditionalLenses`). The preferred model tier is a hint; seating follows `models.*` and the automatic rules in [policy.md](policy.md#models).

`repro` adapts to the policy: with `runner.allowedCommands` set, it runs the narrowest allowed command that proves or disproves each claim; without, it traces the claimed path through the tests and code by hand and says what it could not verify.

## Severities

Every finding has one of four severities:

| Severity | Meaning |
|---|---|
| `blocker` | One surviving blocker blocks the change, regardless of quorum. |
| `important` | A real defect that should be fixed. A hunter's block counts when at least one of its findings survives at `blocker` or `important`, and an open `important` from an earlier round keeps blocking. |
| `nit` | Minor. Never blocks. |
| `pre-existing` | A real problem the change did not introduce. Never blocks. |

Style-only classes (`quorum.dropClasses`: `style`, `formatting`, `naming-preference`, `comment-style`, `whitespace` by default) are dropped. Findings without evidence are refuted by judges. Finding ids are fingerprints computed from the finding's content, so the same issue raised by two seats, or in two rounds, is one finding.

## Judges

Judges are not lenses. A judge receives the hunters' findings and the diff, investigates with the same read-only tools, and votes on each finding: `confirm`, `refute`, or `downgrade` (with a new severity, or one step down). A finding survives when the share of counted judges voting confirm or downgrade reaches `quorum.judgeAgreement` (a judge that does not vote counts against). A judge's votes only count when it passes proof of work, so a judge that did not look cannot clear a blocker.

Judges may raise findings the hunters missed. One survives when two judges raise it, or when only one judge counted, and it is capped at `important`. At tier 3 (`panel.t3.secondJudgeRound`), findings the judges split on go back to every judge for a second vote. With no judge seats (`judges: 0`) or no judge that counted, hunter findings stand unverified and the digest says so.

## Personas

A persona changes only the system-prompt flavour of a seat. The rubric is identical. There is no policy key for personas: the CLI, Action and App seat every reviewer as `skeptical-senior`. Embedders can set `Seat.persona`, or pass `persona` to the prompt builders, in their own pipeline.

| Persona | Stance |
|---|---|
| `skeptical-senior` (default) | Owns the codebase and will be paged if it breaks. Assumes the change is wrong until failing to break it. Decides how they would have built it before judging how it was built. |
| `incident-postmortem` | Writing the postmortem for the incident this change is about to cause. Works backwards from the page at 3am. Prioritises failures that reach production silently. |
| `red-team` | An attacker with a copy of the change. Wants a concrete exploit or failing input, not a vague worry. |
| `new-maintainer` | Inherits the code next quarter with no context. Checks that behaviour is discoverable and that hidden coupling will not bite. |

An unknown persona id is an error.

## Writing a third-party lens

Third-party lenses work in a pipeline you compose yourself (see [architecture.md](architecture.md#composing-your-own-pipeline)): register the lens before the gate builds its first prompt, then list its id in the policy for the tiers that should run it. The CLI, Action and App load no plugins, so they run only the shipped lenses; `policy lint` warns about an unknown lens id, and a seat for one fails.

```ts
import { type Lens, registerLens } from "@merge-safely/lenses";

export const i18nLens: Lens = {
  id: "i18n",                       // kebab-case, unique
  title: "Internationalisation",
  question: "Are new user-facing strings translatable and safe for long or RTL text?",
  classes: ["hard-coded-string", "concatenated-message", "locale-unsafe-format"], // kebab-case, unique
  preferredModelTier: "small",      // optional hint for seating
  conditional: true,                // optional: only seat when relevant (policy decides)
  focus: (input) =>
    [
      "Tools: grep changed UI files for string literals; read the i18n helper and the message catalogue.",
      "Checklist:",
      "1. Every new user-visible string goes through the translation helper.",
      "2. No sentences built by concatenation; use placeholders.",
      "3. Dates, numbers and currency use locale-aware formatting.",
      "Evidence per finding: file:line of the literal and the catalogue key it should use.",
    ].join("\n"),
};

registerLens(i18nLens); // throws if invalid or the id is taken
```

```yaml
# .merge-safely.yml
panel:
  t2: { hunters: [intent, correctness, repro, i18n], judges: 2 }
  conditionalLenses:
    design-fidelity: ["**/*.tsx", "**/*.css", "**/components/**"]
    i18n: ["src/**/*.tsx", "src/locales/**"]
```

Setting `conditionalLenses` replaces the default map, so repeat the `design-fidelity` entry if you still want it.

Rules for `focus`:

- **Pure and fast.** No I/O, no randomness, no clock. Its output is part of a prompt that should be reproducible from the input.
- **Sanitised input only.** `focus` gets changed-file metadata, tier, round, the delta flag and the allowed commands. It never sees the PR title, body, comments, ticket or diff. File paths arrive sanitised to `[A-Za-z0-9._/@+-]` with an `exact` flag; only name files where `exact` is true (the `pathsMatching` and `removedPaths` helpers do this).
- **Say which tools to use.** Which files to read, what to grep for, when `git log` or `blame` helps, which allowed command settles the question. `allowedCommands` may be empty; say what to do instead.
- **Demand evidence.** End with what each finding must cite: file and line, the command and its output, the measured volume.
- **Defects, not taste.** Do not ask for style, naming or formatting findings. They are dropped.
- **Keep it short.** Under about 300 words. The whole instruction budget, rubric included, is about 2.5k tokens.
- **Classes are the contract.** They feed fingerprints, metrics and evals. Use stable, specific kebab-case names. Reuse a shipped class when the meaning is the same.

The process-wide registry never lets a built-in lens be replaced. To customise a built-in, build your own registry with `createLensRegistry(seed)` and pass it to the orchestrator. `validateLens(lens)` returns the problems the registry would reject.

Full details: [`packages/lenses/README.md`](../packages/lenses/README.md).
