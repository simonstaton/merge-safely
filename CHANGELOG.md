# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [0.1.0] - Unreleased

### Added

- `@merge-safely/core`: domain types and ports, the strict policy schema with conservative defaults and a stable hash, the pure stages (intake and redaction, tiering, triage, rounds, proof of work, judge votes, aggregation, digest), seating with decorrelation and fallback, five budget ceilings with the downgrade ladder and alert latch, and the `createGate` orchestrator.
- `@merge-safely/lenses`: eight lenses (`intent`, `correctness`, `repro`, `blast-radius`, `perf`, `security`, `design-fidelity`, `rollout`), four personas, the shared rubric, hunter and judge prompt builders, and nonce-delimited untrusted text.
- `@merge-safely/registry`: model registry with pricing, the pessimistic fallback rate for unknown models, and the cheaper-model lookup used by the downgrade ladder.
- `@merge-safely/providers`: connection kinds and kind inference, the connections file, envelope encryption at rest, gateway normalisation, the provider registry, catalog and model resolution.
- `@merge-safely/tools`: the shared read-only tool set with a runner-observed audit, vendor tool-shape converters and the shared agentic loop.
- `@merge-safely/workspace-local`: disposable per-seat worktrees from a hardened bare mirror, and the working-tree workspace for `--local`.
- `@merge-safely/provider-anthropic`: Messages API runner and Claude Code CLI runner (`--safe-mode`, `--restricted`, `ms-git`), with an opt-in subscription connection.
- `@merge-safely/provider-openai`: Responses API and Chat Completions runners, including OpenAI-compatible endpoints.
- `@merge-safely/provider-gemini`: Gemini Developer API runner.
- `@merge-safely/provider-compatible`: OpenAI-compatible, Anthropic-compatible, Ollama and LM Studio presets (zero cost only on local hosts) and `allProviders()`.
- `@merge-safely/github`: source provider, check run, commit status and PR review reporters, the check-run-backed verdict store with a round-history index comment, trust providers, webhook verification and App auth.
- `@merge-safely/store-memory`, `@merge-safely/store-fs`, `@merge-safely/store-sqlite`: compare-and-set verdict stores and micro-dollar cost ledgers, with shared contract suites.
- `@merge-safely/escalation-slack`: Slack incoming-webhook escalation and reporter.
- `@merge-safely/testkit`: fakes for every port, scripted reviewer runs and sample fixtures.
- `@merge-safely/evals`: eval suite format, runner, text/markdown/JSON reports, regression comparison, circuit breakers and a starter incident suite.
- `@merge-safely/cli`: the `merge-safely` command (`connect`, `connections`, `run`, `run --local`, `estimate`, `explain`, `verdict`, `policy lint`/`init`, `eval`).
- `@merge-safely/action`: the GitHub Action, with check-run verdicts, merge queue support and fork PR safeguards.
- `@merge-safely/app`: the self-hosted GitHub App service with a durable SQLite queue, setup page, encrypted connections, installation budgets with alerts and a human-verdict API.
- Documentation: README, quickstarts, policy reference, connections, budgets, lenses, merge-bot wiring, security model, architecture, and examples (including a type-checked programmatic example).
