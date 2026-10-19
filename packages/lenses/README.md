# @merge-safely/lenses

The shipped reviewer lenses, the shared rubric, reviewer personas and the prompt builders that turn a
`ReviewerInput` into the `{ system, user }` prompt a seat runs with.

A **lens** is one question a reviewer answers (does this break consumers? is the rollout safe?), a checklist that
tells the reviewer how to investigate it, and the finding classes it typically emits. The shared rubric (severities,
evidence, verdict rules, untrusted-text handling) is the same for every lens and is added by the prompt builder, so
a lens only describes what is specific to it.

## Shipped lenses

| id | question | model tier |
|---|---|---|
| `intent` | Right problem, right layer, root cause rather than symptom? | frontier |
| `correctness` | Does the code do what it says? Edge cases, nulls, concurrency, error paths. | frontier |
| `repro` | Can the claimed behaviour be reproduced? | mid |
| `blast-radius` | What else consumes this? | mid |
| `perf` | Query counts, N+1, locks, per-request overhead, bundle size. | mid |
| `security` | Authz, injection, secrets, SSRF, permission widening. | frontier |
| `design-fidelity` | UI: design match, tokens, a11y, RTL, reduced motion. Conditional. | mid |
| `rollout` | Flags, migrations, backfills, data volume, rollback. | mid |

## Usage

```ts
import { buildHunterPrompt, buildJudgePrompt, requireLens } from "@merge-safely/lenses";

const prompt = buildHunterPrompt(requireLens("rollout"), input, { persona: "incident-postmortem", maxRounds: 3 });
const judge = buildJudgePrompt({ ...input, candidateFindings }, { toolsDescription: runner.describeTools() });
```

Personas (`skeptical-senior` default, `incident-postmortem`, `red-team`, `new-maintainer`) only change the system
prompt flavour; the rubric is identical. An unknown persona id throws.

## Authoring a third-party lens

Publish a package that exports a `Lens` and register it at startup:

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

registerLens(i18nLens); // throws if invalid or the id is taken; pass { replace: true } to override deliberately
```

Then list the id in the policy's lens set for the tiers that should run it.

Rules for `focus`:

- **Pure and fast.** No I/O, no randomness, no clock. It runs once per seat and its output is part of a prompt that
  should be reproducible from the input.
- **Trusted input only.** `focus` receives a `LensPromptInput`: changed-file metadata (paths already flattened to a
  single safe line), tier, round, delta flag, allowed commands. It deliberately cannot see the PR title, body,
  comments or diff, so a lens can never interpolate attacker-written text outside an untrusted block. Do not work
  around this.
- **Say which tools to use.** Reviewers do better when told how to investigate: which files to read, what to grep
  for, when git log or blame helps, which allowed command settles the question. `input.allowedCommands` may be
  empty; say what to do instead.
- **Demand evidence.** End with what each finding must cite (file:line, the command and its output, the measured
  volume). Findings without evidence are refuted by judges.
- **Defects, not taste.** Do not ask for style, naming or formatting findings; they are dropped by the pipeline.
- **Keep it short.** Aim for under 300 words. The whole instruction budget, rubric included, is about 2.5k tokens.
- **Classes are the contract.** They feed dedupe fingerprints, metrics and evals. Pick stable, specific kebab-case
  names, do not rename them casually, and prefer reusing a shipped class when the meaning is the same.

`validateLens(lens)` returns the problems the registry would reject, and `createLensRegistry(seed)` gives you an
isolated registry for tests.

## Untrusted text

All PR text, commit messages, comments, ticket text, the diff and prior model findings are rendered only through
`wrapUntrusted(source, text)`, which emits `<untrusted source="...">` ... `</untrusted>` and escapes any tag
lookalike in the content, preceded by `UNTRUSTED_NOTICE`. Other packages can assert there is no leakage with
`appearsOutsideUntrusted(prompt, needle)` and `countUntrustedDelimiters(prompt)`.

## Prompt drift

`src/__snapshots__/prompt.test.ts.snap` holds a full hunter prompt for the correctness lens. Any wording change
shows up in review as a snapshot diff; update it with `npx vitest run packages/lenses -u` and review the diff.
