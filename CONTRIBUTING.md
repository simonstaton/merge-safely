# Contributing

Thanks for helping. Merge Safely is an npm workspaces monorepo in TypeScript (ESM, NodeNext). The design is in [docs/design.md](docs/design.md). Read the section for the package you are changing before you write code.

## Setup

Node 20 or later (see `.nvmrc`).

```bash
git clone https://github.com/simonstaton/merge-safely.git
cd merge-safely
npm ci
npm run build
```

`git` must be on your `PATH` (the workspace, tools and eval tests use it). `ripgrep` is used when installed.

## Commands

```bash
npm run lint           # biome check (format + lint)
npm run lint:fix       # apply biome fixes
npm run typecheck      # whole repo including tests, from source
npm run build          # tsc -b (project references) -> packages/*/dist
npm test               # vitest; resolves @merge-safely/* to source
npm run check          # lint + typecheck + test
npm run clean          # remove every dist/ and tsbuildinfo
npx vitest run packages/core   # one package
```

All four (`lint`, `typecheck`, `build`, `test`) must pass before you open a PR. CI (`.github/workflows/ci.yml`) runs exactly these on Node 20 for every pull request and every push to `main`.

To try your change end to end:

```bash
node packages/cli/dist/bin.js --home /tmp/ms-home --help        # the CLI, with a scratch state directory
node packages/cli/dist/bin.js eval --suite packages/evals/suites/starter --dry
npx tsc --noEmit -p examples/programmatic/tsconfig.json          # the programmatic example still compiles
```

`npm link -w packages/cli` puts your build on the `PATH` as `merge-safely`. The App runs with `node packages/app/dist/main.js` (see [docs/quickstart-app.md](docs/quickstart-app.md)).

## Packages

| Directory | Package |
|---|---|
| `packages/core` | Domain types, ports, policy schema, pure stages, budgets, orchestrator. |
| `packages/lenses`, `registry`, `providers`, `tools` | Pure or near-pure building blocks. |
| `packages/provider-anthropic`, `provider-openai`, `provider-gemini`, `provider-compatible` | Model provider adapters. |
| `packages/github`, `workspace-local`, `store-memory`, `store-fs`, `store-sqlite`, `escalation-slack` | Port adapters. |
| `packages/cli`, `action`, `app` | Entry points. |
| `packages/evals`, `testkit` | The eval runner and suites; fakes for tests. |

Each package has a README; read it before you change the package. The architecture is in [docs/architecture.md](docs/architecture.md).

## Package rules

- `packages/<name>` publishes `@merge-safely/<name>`.
- `core` has **zero I/O and no vendor SDKs**. Anything that touches a VCS, a model, a filesystem or a network is a port in `core/src/ports.ts` with an adapter in its own package.
- Keep a PR inside one package where possible. Do not edit root files (`package.json`, `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `.github/`) unless the change is about them.
- Add dependencies to your package's `package.json`, run `npm install` from the root, and commit the `package-lock.json` change.
- Do not change `core/src/types.ts` or `core/src/ports.ts` casually. If you need a contract change, add a backwards-compatible optional field and call it out in the PR description.
- Import other packages by name (`@merge-safely/core`), never by relative path across packages.
- Relative imports inside a package use the `.js` extension (`./foo.js`).

## Coding standards

- Biome: 2-space indent, double quotes, semicolons, 120 columns. Run `npm run lint:fix` before committing.
- `catch (err: unknown)`, never `any`. Prefer `unknown` plus type guards.
- `node:` prefix for built-ins.
- Tests live next to source as `*.test.ts`. Every pure function gets a test. Adapters get tests with fakes (`@merge-safely/testkit` has one for every port). Tests never call a real network.
- No telemetry, no phone-home.
- Secrets never appear in logs, prompts, verdicts or error messages. Test that they do not.

## Security contract

Every change must keep the runner contract in [docs/security.md](docs/security.md):

- Reviewers get read-only tools in a disposable workspace.
- PR title, body, comments and commit messages are untrusted and only enter prompts inside delimited data blocks.
- Output JSON is validated by the runner.
- Proof of work is observed by the runner, never self-reported.
- Budgets are hard.

If you find a way to break it, report it privately (see [SECURITY.md](SECURITY.md)) rather than in a public PR.

## Pull requests

- Branch from `main`. Title: `<package>: <what>`, for example `store-sqlite: index cost_entries by connection` (`docs: …` for documentation).
- Describe what changed and why, and how you tested it.
- Call out any change to a port, a domain type, the policy schema or a default. Policy defaults change the policy hash on every verdict.
- Add a line to `CHANGELOG.md` under the unreleased version for anything user-visible, and update the docs that describe it.
- Keep PRs small. One concern per PR.
- The GitHub Action ships a committed bundle (`packages/action/dist/`) that embeds every package it uses. If your change touches any package the Action depends on (almost all of them), run `npm run build && npm run bundle -w @merge-safely/action` and commit the regenerated `dist/`. CI fails on a stale bundle, including after `main` moves under your branch.

`main` is protected:

- The CI check must pass.
- The branch must be up to date with `main` before it merges; rebase or merge `main` in when it moves.
- PRs are squash-merged, so the PR title becomes the commit subject on `main`. Write it accordingly.

## Adding a provider

1. Create `packages/provider-<name>` implementing `ModelProvider` and `ModelRunner` from `@merge-safely/core`.
2. Use the shared tool executor passed in `RunnerOptions.tools`. Do not write your own tools; proof of work must mean the same thing for every provider.
3. Enforce `seat.budget` (turns, dollars, deadline). Report usage through `onUsage` as each response arrives. Price with `@merge-safely/registry`; unknown models get the pessimistic fallback rate.
4. Classify budget stops as `budget-exceeded` with recovery text, never `error`.
5. `validate` and `run` never throw. Set every SDK option explicitly so no environment variable can redirect the key or the PR.
6. Scrub connection secrets and secret-shaped strings from every string you return.
7. Add the provider's models to the registry if they are not there.
8. Add it to `allProviders()` in `packages/provider-compatible` so the CLI, Action and App can serve it, and teach `@merge-safely/providers` its connection kinds if they are new.
9. Tests with a fake client. Write a README with the connection kinds, runner behaviour and known gaps, following `packages/provider-openai/README.md`.

## Adding a lens

Shipped lenses live in `packages/lenses/src/lenses/`. Third-party lenses are packages that call `registerLens`. See [docs/lenses.md](docs/lenses.md#writing-a-third-party-lens). For a shipped lens:

- Pick stable kebab-case finding classes; reuse existing ones where the meaning matches.
- Keep `focus` pure and short.
- Update the prompt snapshot (`npx vitest run packages/lenses -u`) and review the diff.

## Adding a store

Implement `VerdictStore` and `CostLedger` from `@merge-safely/core`, then run the shared contract suites from `@merge-safely/store-memory`:

```ts
import { costLedgerContract, verdictStoreContract } from "@merge-safely/store-memory";
import * as t from "vitest";

verdictStoreContract(t, "mine", async () => ({ store, close }));
costLedgerContract(t, "mine", async (clock) => ({ ledger: makeLedger({ now: clock.now }), close }));
```

Compare-and-set must be atomic: two writers must never both win. Money is integer micro-dollars rounded up. Repo keys compare case-insensitively.

## Eval cases

The eval suite and incident cases are the project's most valuable asset. If Merge Safely missed something real, or blocked something clean, an anonymised case for `merge-safely eval` is one of the most useful contributions you can make. Strip names, secrets and anything that identifies your organisation.

```bash
node packages/cli/dist/bin.js eval init packages/evals/suites/starter --case my-incident --kind incident --title "What went wrong"
node packages/cli/dist/bin.js eval --suite packages/evals/suites/starter --ids my-incident --dry
```

`eval init` writes a commented `case.yml` and empty `base/` and `head/` trees; the case fails validation until you fill them in. The case format is in [packages/evals/README.md](packages/evals/README.md).

## Licence

By contributing you agree that your contributions are licensed under Apache-2.0.
