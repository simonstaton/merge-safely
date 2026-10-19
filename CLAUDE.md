# Merge Safely — contributor guide

Adversarial, risk-tiered, model-agnostic AI code review that produces a commit-pinned merge signal for GitHub PRs.
The design doc is `docs/design.md`. Read the section for your package before writing code.

## Layout
npm workspaces monorepo, TypeScript, ESM (NodeNext). `packages/<name>` publishes `@merge-safely/<name>`.
- `core` — domain types (`src/types.ts`), ports (`src/ports.ts`), policy schema (`src/policy`), output schemas (`src/schema`), pure pipeline stages, orchestrator. **Zero I/O, no vendor SDKs.**
- `lenses`, `registry`, `providers`, `tools` — pure or near-pure building blocks.
- `provider-*`, `github`, `store-*`, `workspace-*`, `escalation-*` — adapters implementing the ports.
- `cli`, `action` — entry points. `evals` — eval suite.

## Rules that keep parallel work conflict-free
- Work only inside your assigned package directory (plus `examples/` or `docs/` files you were told to own).
- **Never edit root files** (`package.json`, `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `.github/`) unless the task says so.
  Add dependencies to *your package's* `package.json` and run `npm install` from the repo root; commit the `package-lock.json` change.
- Do not change `packages/core/src/types.ts` or `packages/core/src/ports.ts` unless your task explicitly owns them. If you need a contract change, add a backwards-compatible optional field and call it out in your PR description.
- Imports between packages go through the package name (`@merge-safely/core`), never relative paths across packages.
- Relative imports inside a package use the `.js` extension (`./foo.js`), required by NodeNext.

## Commands
```bash
npm install            # from root
npm run lint           # biome
npm run lint:fix
npm run typecheck      # whole repo incl. tests, from source
npm run build          # tsc -b (project references) -> packages/*/dist
npm test               # vitest, resolves @merge-safely/* to source
npx vitest run packages/core   # one package
```
All four (`lint`, `typecheck`, `build`, `test`) must pass before a PR is opened. CI runs the same.

## Coding standards
- Biome: 2-space, double quotes, semicolons, 120 cols. `npm run lint:fix` before committing.
- `catch (err: unknown)`, never `any`. Prefer `unknown` + type guards.
- `node:` prefix for built-ins.
- Tests live next to source as `*.test.ts` (vitest). Every pure function gets a test. Adapters get tests with fakes; never call a real network in tests.
- No telemetry, no phone-home. Secrets never in logs, prompts, verdicts or error messages.
- PR titles: `<package>: <what>`; keep PRs scoped to one package where possible.

## Security contract (section 8 of the design)
Reviewers get read-only tools in a disposable workspace. PR title/body/comments/commit messages are untrusted and only enter prompts inside delimited data blocks. Output JSON is validated by the runner. Proof of work is observed by the runner, never self-reported. Budgets are hard.
