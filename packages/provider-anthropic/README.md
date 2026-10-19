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
- **deadlineMs**: the Messages runner aborts the in-flight request; the CLI's process group is sent SIGTERM, then
  SIGKILL after a grace period. Status `timeout`, even if a result had already been printed.
- **maxUsd**: the Messages runner prices each response and stops once spend reaches the cap; the CLI gets
  `--max-budget-usd`. Models without pricing are charged at the registry's pessimistic rate (the max of every
  known rate, `withPricing` from `@merge-safely/registry`), so the cap always enforces; such costs are estimates
  and a warning is logged.

A budget stop is `budget-exceeded` with recovery text (raise the ceiling, re-run the check), never `error`
(design 7.6). CLI exits go through core's `classifyRunnerExit`: budget-exceeded needs a non-zero exit with no
signal, evidence of the cap (`error_max_turns` / `error_max_budget_usd`, turns at the cap, or spend at 95% of it),
and clean stderr. Any signal death is `error` (or `timeout` if the runner killed it). A `result` event is trusted
only when the process then exits with code 0 and no signal, and only if it is the last event on the stream.

**Usage reporting.** The Messages runner calls `onUsage` after every response. The Claude Code CLI reports
usage only in its final `result` event, so the CLI runner calls `onUsage` once, at exit. If the process is killed
before that, the runner reports the per-message usage it already saw, priced from the registry.

Retries (Messages runner): 429, 529, 5xx and network errors are retried up to 3 times with exponential backoff.
A server `retry-after` is always honoured in full, and the seat deadline is the only cap: a retry that would end
past the deadline stops the seat as `timeout`.

Messages runner turn rules: a turn that ends without `submit_review` (prose, or `max_tokens`) first tries to
salvage JSON from the text, then gets one reminder, then the seat is `schema-invalid`. Tool calls in a
`max_tokens` response are never executed (their input may be truncated). A valid `submit_review` wins: other calls
in the same response are neither executed nor counted. The prompt cache keeps a breakpoint on the system block and
moves the message breakpoint to the latest user or tool-result message each turn.

## CLI runner security

`claude -p` is started with:

- `--safe-mode`: no CLAUDE.md (the checkout's own included), skills, hooks, plugins, MCP servers or custom
  agents. Auth keeps working, unlike `--bare`.
- `--restricted`: the file tools (Read/Grep/Glob) are confined to the checkout, and settings files are ignored.
- `--system-prompt` (replace, not append), so Claude Code's default prompt, which embeds git status (branch name and
  commit subjects, both untrusted), never reaches the model.
- `--tools Read,Grep,Glob,Bash`, `--allowedTools Read,Grep,Glob,LS,Bash(ms-git:*)` plus one `Bash(<cmd>:*)` per
  policy-allowed command, `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,Bash(git:*)`
  and `--permission-mode dontAsk`, which denies anything not pre-approved. A policy command is rejected, with a
  warning, if it contains shell metacharacters, is a bare interpreter or shell (`node`, `python3`, `bash`, `env`,
  `find`, `xargs`, ...), or is raw `git`.
- `--setting-sources ""`, `--strict-mcp-config`, `--no-session-persistence`.

**`ms-git`, never `git`.** Raw git options write and read anywhere (`--output=<file>`, `--no-index`) or run
programs (`--ext-diff`, `--textconv`). The runner puts an `ms-git` launcher on the child's `PATH` (a temp bin dir)
that runs the compiled `dist/git-wrapper.js` with its working directory pinned to the checkout. The wrapper:

- accepts only `diff`, `log`, `blame` and `show`;
- accepts flags only from an allowlist (`--stat -p --oneline -n<N> -<N> --max-count=<N> -L<a>,<b>[:path]
  --follow --name-only --name-status -U<N> --no-color`, plus `--format=`/`--pretty=` with safe `%` placeholders);
- resolves every revision to a SHA with `git rev-parse --verify <rev>^{commit}` and rejects `@{`, `:/` and `^{/`;
- keeps paths inside the checkout and passes them after `--`;
- runs git with `GIT_LITERAL_PATHSPECS=1`, `-c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat`,
  `--no-ext-diff` and `--no-textconv`.

The launcher is a POSIX shell script, so the CLI runner's git access is POSIX-only.

**Environment.** Only `PATH`, locale/temp variables and proxy/CA settings are copied from the gate's environment.
No `ANTHROPIC_*` or `CLAUDE_*` variable is ever copied; the credential comes only from the connection. For every
kind except `subscription`, `HOME`, the `XDG_*` dirs and `CLAUDE_CONFIG_DIR` point into an empty temporary
directory, so no host credentials (`~/.claude`, `~/.config/gh`, ...) exist for the seat to read. Privacy flags
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and
`DISABLE_AUTOUPDATER` are set.

**Output scrubbing.** Before any `ReviewerOutput`/`JudgeOutput` or error text is returned, both runners replace
connection secrets, credential-looking values from the gate's environment, and secret-shaped strings (`sk-`,
`sk-ant-`, `ghp_`/`gho_`/`github_pat_`, `AKIA`, PEM private keys, bearer tokens, URL userinfo) with
`[REDACTED]` in every string field (summary, titles, details, evidence, suggested fixes).

## Subscription connections (opt-in, default off)

A `subscription` connection runs reviews on **your personal Claude login** through the Claude Code CLI. Whether
automated use of a consumer subscription is allowed is a terms-of-service question for you, the installing user,
not for this project (design 7.1). It is off unless you create such a connection on purpose. Under a subscription,
models are marked `zeroCost` (plan-included). Dollar ceilings do not trip and `--max-budget-usd` is not passed.
The plan's own usage window is the real limit.

**Residual risk under subscription.** The login lives in your real `HOME`, so `HOME` is not replaced for this
kind (`credentialFileRef` may point `CLAUDE_CONFIG_DIR` at a dedicated config dir). `--restricted` keeps the file
tools inside the checkout, and Bash allows only `ms-git` and the policy's commands. But a policy-allowed test
command runs the PR's own code with your user's access, and could read `~/.claude/.credentials.json` or other
files in your home. Output scrubbing catches known secret shapes but not arbitrary file contents. Only allow test
commands under a subscription connection for repositories and authors you trust, or run the gate in a container.
