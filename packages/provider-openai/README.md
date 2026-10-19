# @merge-safely/provider-openai

`ModelProvider` for OpenAI and for any endpoint that speaks the OpenAI API (OpenRouter, Together,
Fireworks, Ollama, LM Studio, vLLM, internal gateways). The runner is agentic: the reviewer
investigates the checkout through the shared read-only tool set (executed by the runner, never the
model) and finishes by calling a `submit_review` function whose parameters are the review JSON schema.

```ts
import { openaiCompatibleProvider, openaiProvider } from "@merge-safely/provider-openai";

const provider = openaiProvider();             // id "openai": api-key, oauth, openai-compatible
const gateways = openaiCompatibleProvider();   // id "openai-compatible": openai-compatible only
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

Register `openaiProvider()` for connections with `provider: "openai"` and `openaiCompatibleProvider()`
for connections with `provider: "openai-compatible"`. Both use the same implementation, so a lookup by
`conn.provider === provider.id` works for either.

The API key, base URL, organization, project and log level are always set explicitly. The SDK
therefore never reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` or
`OPENAI_LOG` from the environment. `OPENAI_LOG=debug` would otherwise print custom connection headers
and full request bodies, including the PR diff. A keyless compatible connection sends a placeholder key
rather than falling back to `OPENAI_API_KEY`, which would hand your real OpenAI key to a third-party
server. An empty key is rejected.

## `options.api`

Set `options.api` on the connection record to pick the wire API:

- `"responses"`: the OpenAI Responses API. Default for `api-key` and `oauth`. Requests use
  `store: false`. Reasoning items come back as encrypted content (`include: ["reasoning.encrypted_content"]`).
  Each turn's output items are replayed verbatim, with their ids, reasoning items and empty messages,
  followed by the `function_call_output` items. A trailing reasoning item with nothing after it is
  dropped. Nothing about the PR is kept on the provider side.
  `seat.model.effort` becomes `reasoning: { effort }`.
- `"chat"`: Chat Completions with `tools` function calling. Default for `openai-compatible`, because
  most gateways and local servers only implement this. `seat.model.effort` becomes `reasoning_effort`.
  An assistant turn with neither content nor tool calls is never replayed, because gateways reject it;
  after an empty reply, the nudge goes as a user message only.

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
  "provider": "openai-compatible",   // served by openaiCompatibleProvider()
  "kind": "openai-compatible",
  "options": { "api": "chat" },     // optional; add "strict": true only if the gateway supports strict schemas
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
  required), and only to api.openai.com or to a gateway whose connection sets `options.strict: true`.
  If the server returns a 400 that mentions `strict`, `schema` or `additionalProperties`, the runner
  resends the turn non-strict. Every `submit_review` call in a turn is checked, and the first valid one
  is accepted. The arguments are validated with `parseReviewerOutput`, or `parseJudgeOutput` when
  `seat.role === "judge"`. An invalid submission goes back to the model as a tool error, and after two
  retries the run is `schema-invalid`. When the model replies in plain text, the runner first tries
  `extractJson` on it, then nudges the model to call `submit_review`.
- **Budgets.** `maxTurns` and `maxUsd` both end the run with `budget-exceeded`, and `error` says how to
  recover. `deadlineMs` ends it with `timeout`. An external `signal` ends it with `error`. The `maxUsd`
  check happens before every request and before tools run. If the response that crosses the cap
  contains a valid submission, that submission is kept, because those tokens are already paid for.
  Spend is priced with `@merge-safely/registry`. A model without pricing is charged the registry's
  pessimistic fallback rate, so `maxUsd` still applies (it can only over-estimate), and the logger
  warns.
- **Usage.** Usage is streamed per response to `onUsage`. `in` counts uncached input tokens and
  `cachedIn` counts cached input (`input_tokens_details` / `prompt_tokens_details.cached_tokens`).
  `out` includes reasoning tokens.
- **Retries.** SDK retries are disabled. The runner retries the following up to 3 times, with jittered
  exponential backoff that honours `retry-after-ms` / `Retry-After`:
  - 408, 409, 425, 429 and 5xx responses
  - SDK connection errors and timeouts
  - system and undici codes such as `ECONNRESET`, `EAI_AGAIN` and `UND_ERR_SOCKET`

  Errors are classified with the SDK's error classes. `insufficient_quota` is not retried. If the next
  retry would start after the seat deadline, the run stops at once with `error` ("rate limited beyond
  the seat deadline") instead of waiting until it times out.
- **Secrets.** Every error string is redacted of the connection's key, token and header values, and of
  common key shapes, before it reaches `run.error`, a log or a validation message.

## Pricing

Model metadata and prices come from `@merge-safely/registry` (`findModel`): an exact id, or a safe
date/version-suffix match. Anything else, such as `gpt-5-pro`, goes through `withPricing` and gets
the pessimistic fallback rate. `gpt-4o-2024-05-13` is never priced at the `gpt-4o` rate.

## Known gap: Codex CLI runner

Design section 7.3 also lists a Codex CLI runner (non-interactive `codex exec` with an allowlisted tool
set, and the audit built from its event stream). This package does not have it yet: OpenAI models run
only through the API runner above. Like the Claude Code CLI runner, it will need its own audit
extraction so that proof of work stays runner-observed.

## Known gap: spend of an in-flight request at the deadline

Requests are not streamed. When the seat deadline aborts a request that is in flight, the provider may
still bill for it, but its usage never comes back, so it never reaches `onUsage` or the audit. The
ledger can therefore under-count by at most that one in-flight response. Streaming usage would close
this gap.
