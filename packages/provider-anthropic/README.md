# @merge-safely/provider-anthropic

Anthropic adapter for Merge Safely: a `ModelProvider` with two `ModelRunner`s.

- **Messages API runner** (`MessagesRunner`): an agentic loop over the shared read-only tool set
  (`RunnerOptions.tools`) plus a `submit_review` tool whose input schema is the seat's output schema.
- **Claude Code CLI runner** (`ClaudeCodeRunner`): `claude -p --output-format stream-json`, with allowlisted
  read-only tools and `--json-schema`. The audit is built from the CLI's own `tool_use` events.

```ts
import { anthropicProvider } from "@merge-safely/provider-anthropic";

const provider = anthropicProvider();
const check = await provider.validate(connection); // never throws
const runner = provider.createRunner(connection, modelInfo, { tools, onUsage, logger });
const run = await runner.run(seat, input, workspace); // never throws; always a complete ReviewerRun
```

## Connection kinds

| Kind | Secret | Messages API client | CLI env |
|---|---|---|---|
| `api-key` | `{ apiKey }` | `x-api-key`, base URL `https://api.anthropic.com` (or `options.baseUrl`) | `ANTHROPIC_API_KEY` |
| `anthropic-compatible` | `{ baseUrl, apiKey, headers? }` | `x-api-key` against `baseUrl`, extra headers sent as-is | `ANTHROPIC_BASE_URL`, plus `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` when `options.authHeader: "bearer"`), `ANTHROPIC_CUSTOM_HEADERS` |
| `oauth` | `{ accessToken, ... }` | `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` | `ANTHROPIC_AUTH_TOKEN` (or `CLAUDE_CODE_OAUTH_TOKEN` when `options.oauthEnv: "claude-code"`) |
| `subscription` | `{ credentialFileRef? }` | n/a | nothing; the user's own Claude Code login. `credentialFileRef` becomes `CLAUDE_CONFIG_DIR` |

`validate()` lists models for the API kinds (401 → `invalid key`, network → `unreachable`) and, for
`subscription`, checks that `claude --version` runs.

## Which runner is used

- `conn.kind === "subscription"` → CLI runner (there is no API key to call the Messages API with).
- `conn.options.runner === "cli"` → CLI runner, for any kind.
- Otherwise → Messages API runner.

The CLI binary defaults to `claude` on `PATH`; override with `anthropicProvider({ cli: { binary } })` or
`conn.options.claudeBinary`.

## Budgets and classification

Both runners enforce `seat.budget`:

- **maxTurns**: one Messages API round trip is one turn; the CLI gets `--max-turns`.
- **deadlineMs**: the Messages runner aborts the in-flight request; the CLI is sent SIGTERM, then SIGKILL after
  a grace period. Status `timeout`.
- **maxUsd**: the Messages runner prices each response from `model.pricing` and stops once spend reaches the cap;
  the CLI gets `--max-budget-usd`. If the model has no pricing, the cap cannot be enforced and a warning is
  logged.

A budget stop is reported as `budget-exceeded` with recovery text (raise the ceiling, re-run the check), never
as `error` (design 7.6). This includes the CLI's `error_max_turns` and `error_max_budget_usd` exits.

Usage: the Messages runner calls `onUsage` after every response. The CLI only reports totals in its final
`result` event, so `onUsage` fires once at the end. If the process is killed before that, the runner reports
the per-message usage it already saw, priced from the local table.

Retries (Messages runner): 429, 529, 5xx and network errors are retried up to 3 times with exponential backoff
that honours `retry-after`. The runner does the retrying, not the SDK, so it never waits past the deadline.

## CLI runner security

The child process gets:

- a **scrubbed environment**: only `PATH`, `HOME`, locale/temp variables and proxy/CA settings are copied. No
  `ANTHROPIC_*` or `CLAUDE_*` variable is ever copied from the gate's environment; the credential comes only
  from the connection.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`,
  `DISABLE_AUTOUPDATER=1`.
- `--tools Read,Grep,Glob,Bash`, `--allowedTools Read,Grep,Glob,LS,Bash(git diff:*),Bash(git log:*),Bash(git blame:*),Bash(git show:*)`
  plus one `Bash(<cmd>:*)` per policy-allowed command (a command with shell metacharacters is rejected),
  `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent`, and
  `--permission-mode dontAsk`, which denies anything that is not pre-approved.
- `--setting-sources ""` and `--strict-mcp-config`: settings files (including hooks) and MCP servers are not
  loaded from the checkout under review or from the host.
- `--no-session-persistence`.

Error messages from both runners are scrubbed of the connection's secrets and of anything shaped like a
credential.

## Subscription connections (opt-in, default off)

A `subscription` connection runs reviews on **your personal Claude login** through the Claude Code CLI. Whether
automated use of a consumer subscription is allowed is a terms-of-service question for you, the installing user,
not for this project (design 7.1). It is off unless you create such a connection on purpose. Under a subscription,
models are marked `zeroCost` (plan-included). Dollar ceilings do not trip and `--max-budget-usd` is not passed.
The plan's own usage window is the real limit.
