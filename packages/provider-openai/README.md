# @merge-safely/provider-openai

`ModelProvider` for OpenAI and for any endpoint that speaks the OpenAI API (OpenRouter, Together,
Fireworks, Ollama, LM Studio, vLLM, internal gateways). The runner is agentic: the reviewer
investigates the checkout through the shared read-only tool set (executed by the runner, never the
model) and finishes by calling a `submit_review` function whose parameters are the review JSON schema.

```ts
import { openaiProvider } from "@merge-safely/provider-openai";

const provider = openaiProvider();
const check = await provider.validate(conn); // never throws; { ok, message, models?, latencyMs }
const runner = provider.createRunner(conn, model, { tools, onUsage, logger });
const run = await runner.run(seat, input, workspace, signal); // never throws; always a ReviewerRun
```

## Connection kinds

| kind | secret | base URL | default wire API |
|---|---|---|---|
| `api-key` | `{ apiKey }` | `https://api.openai.com/v1` (fixed) | `responses` |
| `oauth` | `{ accessToken }` (sent as the bearer token) | `https://api.openai.com/v1` (fixed) | `responses` |
| `openai-compatible` | `{ baseUrl, apiKey?, headers? }` | `baseUrl` | `chat` |

The base URL, organization and project are always set explicitly, so the SDK never picks up
`OPENAI_BASE_URL`, `OPENAI_ORG_ID` or `OPENAI_API_KEY` from the environment. A keyless compatible
connection sends a placeholder key rather than falling back to `OPENAI_API_KEY`, which would hand your
real OpenAI key to a third-party server.

## `options.api`

Set `options.api` on the connection record to pick the wire API:

- `"responses"`: the OpenAI Responses API. Default for `api-key` and `oauth`. Requests use
  `store: false`. Reasoning items come back as encrypted content (`include: ["reasoning.encrypted_content"]`)
  and are carried between turns, so nothing about the PR is kept on the provider side.
  `seat.model.effort` becomes `reasoning: { effort }`.
- `"chat"`: Chat Completions with `tools` function calling. Default for `openai-compatible`, because
  most gateways and local servers only implement this. `seat.model.effort` becomes `reasoning_effort`.

The runner never sends `temperature`.

## Examples (openai-compatible)

| Service | `baseUrl` | Notes |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | model ids like `openai/gpt-5`, `anthropic/claude-sonnet-4.5`; optional `headers: { "HTTP-Referer": "...", "X-Title": "merge-safely" }` |
| Together | `https://api.together.xyz/v1` | |
| Fireworks | `https://api.fireworks.ai/inference/v1` | |
| Ollama | `http://localhost:11434/v1` | no key needed; pick a model with tool support (e.g. `qwen2.5-coder`, `llama3.1`) |
| LM Studio | `http://localhost:1234/v1` | no key needed; enable tool use for the loaded model |
| vLLM | `http://<host>:8000/v1` | start with `--enable-auto-tool-choice --tool-call-parser <parser>` |

```jsonc
{
  "id": "local-ollama",
  "provider": "openai-compatible",
  "kind": "openai-compatible",
  "options": { "api": "chat" },
  "secret": { "kind": "openai-compatible", "baseUrl": "http://localhost:11434/v1" }
}
```

`validate` on a compatible endpoint treats a 404 from `/models` as "base URL does not expose /models,
assuming reachable" (`ok: true`, no model list). `models()` returns `[]` when listing fails, and the CLI
then lets you name the model yourself.

## Runner behaviour

- **Tools.** `RunnerOptions.tools` (the shared read-only executor) is bound to the workspace with
  `input.allowedCommands`. Tool calls go through `ToolExecutor.execute`, and results (or `ERROR: ...`) are
  sent back to the model. Calls to unknown tools get an error result and are never executed.
- **Output.** `submit_review` takes `input.outputSchema` as its parameters. The schema is sent with
  `strict: true` only when it fits OpenAI's strict subset (every object closed, every property
  required). If the server returns a 400 that mentions strict or schema, the runner resends the turn
  non-strict. The arguments are validated with `parseReviewerOutput`, or `parseJudgeOutput` when
  `seat.role === "judge"`. An invalid submission goes back to the model as a tool error, and after two
  retries the run is `schema-invalid`. When the model replies in plain text, the runner first tries
  `extractJson` on it, then nudges the model to call `submit_review`.
- **Budgets.** `maxTurns` and `maxUsd` both end the run with `budget-exceeded`, and `error` says how to
  recover. `deadlineMs` ends it with `timeout`. An external `signal` ends it with `error`. The `maxUsd`
  check happens before every request and before tools run. If the response that crosses the cap
  contains a valid submission, that submission is kept, because those tokens are already paid for. A
  model with unknown pricing has `costUsd: undefined`, and the logger warns that `maxUsd` cannot be
  enforced for it.
- **Usage.** Usage is streamed per response to `onUsage`. `in` counts uncached input tokens and
  `cachedIn` counts cached input (`input_tokens_details` / `prompt_tokens_details.cached_tokens`).
  `out` includes reasoning tokens.
- **Retries.** SDK retries are disabled. The runner retries 408/409/429/5xx and network errors up to 3
  times, with jittered exponential backoff that honours `retry-after-ms` / `Retry-After`.
  `insufficient_quota` is not retried.
- **Secrets.** Every error string is redacted of the connection's key, token and header values, and of
  common key shapes, before it reaches `run.error`, a log or a validation message.

## Pricing

The package holds a small local table of first-party models (exact ids, with dated snapshots
normalised). Any other model has `pricing: undefined`, so budgets fall back to the registry's
pessimistic rate. The table is never applied to `openai-compatible` connections, because a gateway
charges its own prices.

## Known gap: Codex CLI runner

Design section 7.3 also lists a Codex CLI runner (non-interactive `codex exec` with an allowlisted tool
set, and the audit built from its event stream). This package does not have it yet: OpenAI models run
only through the API runner above. Like the Claude Code CLI runner, it will need its own audit
extraction so that proof of work stays runner-observed.
