# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [0.1.0] - Unreleased

### Added

- `@merge-safely/core`: domain types, ports, policy schema with conservative defaults and a stable policy hash, seating with decorrelation and fallback, budget ceilings, edge-triggered alerts, the downgrade ladder and runner exit classification.
- `@merge-safely/lenses`: eight lenses (`intent`, `correctness`, `repro`, `blast-radius`, `perf`, `security`, `design-fidelity`, `rollout`), four personas, the shared rubric, hunter and judge prompt builders, and nonce-delimited untrusted text.
- `@merge-safely/registry`: model registry with pricing and a pessimistic fallback rate for unknown models.
- `@merge-safely/providers`: connection kinds, the connections file, envelope encryption at rest, the provider registry and model resolution.
- `@merge-safely/provider-anthropic`: Messages API runner and Claude Code CLI runner, with an opt-in subscription connection.
- `@merge-safely/provider-openai`: Responses API and Chat Completions runners, including OpenAI-compatible endpoints.
- `@merge-safely/provider-gemini`: Gemini Developer API runner.
- `@merge-safely/store-memory`, `@merge-safely/store-fs`, `@merge-safely/store-sqlite`: verdict stores and cost ledgers, with shared contract suites.
- `@merge-safely/escalation-slack`: Slack incoming-webhook escalation and reporter.
- The `merge-safely` CLI, the GitHub Action and the self-hosted GitHub App.
- Documentation: README, quickstarts, policy reference, connections, budgets, lenses, merge-bot wiring, security model, architecture, and examples.
