# @merge-safely/provider-gemini

`ModelProvider` for Google Gemini through the Gemini Developer API (`@google/genai`,
`models.generateContent`). It uses the same agentic loop as the OpenAI provider. The reviewer
investigates through the shared read-only tool set, declared as `functionDeclarations`, and finishes
by calling `submit_review`, whose `parametersJsonSchema` is the review JSON schema. `responseSchema`
is not used, because the function carries the schema.

```ts
import { geminiProvider } from "@merge-safely/provider-gemini";

const provider = geminiProvider();
await provider.validate(conn);                 // never throws
const run = await provider.createRunner(conn, model, { tools, onUsage }).run(seat, input, ws, signal);
```

## Connection kinds

| kind | secret |
|---|---|
| `api-key` | `{ apiKey }` from Google AI Studio |

The client pins everything the SDK would otherwise read from the environment:
- the API key, so `GOOGLE_API_KEY` / `GEMINI_API_KEY` are never used (an empty key is rejected)
- `vertexai: false`, so `GOOGLE_GENAI_USE_VERTEXAI` and `GOOGLE_APPLICATION_CREDENTIALS` are never used
- `httpOptions.baseUrl: "https://generativelanguage.googleapis.com"` with `apiVersion: "v1beta"`, so
  `GOOGLE_GEMINI_BASE_URL` cannot send the key and the PR to another host

Vertex AI (cloud credentials) will come later as a `cloud` adapter.

## Models

`validate` and `models` list `models.list()` and keep only `gemini-*` text models that support
`generateContent`, dropping embedding, TTS, image, live and similar models. Tiers come from the id:
`*-pro` is frontier, `*-flash` is mid, `*-flash-lite` is small. Context and output limits come from the
API's `inputTokenLimit` / `outputTokenLimit`, otherwise from the registry. Prices come from
`@merge-safely/registry`. The registry records the higher, above-200k-prompt band for Pro models.
Models it does not know get its pessimistic fallback rate, so `maxUsd` always applies.

## Runner behaviour

- Each model turn is added back to the history unchanged. This keeps the thought signatures on
  function-call parts, which Gemini 3 needs when thinking is combined with function calling.
- Gemini often leaves function-call ids out. The runner makes up ids for its own bookkeeping and
  includes a `functionResponse.id` only when the model sent one.
- `seat.model.effort` becomes `thinkingConfig.thinkingLevel` on Gemini 3.x, and
  `thinkingConfig.thinkingBudget` on 2.5 (minimal 0, low 1024, medium 8192, high 24576). A level is
  sent only when the model advertises it, through `model.effortLevels` or, failing that, a local
  family table. For example, 3.x Pro advertises only low and high. A level the model does not
  advertise is omitted, with a warning.
- Usage is streamed per response. `in` is `promptTokenCount - cachedContentTokenCount`, `cachedIn` is
  `cachedContentTokenCount`, and `out` is `candidatesTokenCount + thoughtsTokenCount`, since thinking
  is billed as output.
- Schema validation, invalid-submission retries (2, then `schema-invalid`), plain-text `extractJson`
  salvage, `maxTurns` / `maxUsd` (`budget-exceeded`, with recovery text), `deadlineMs` (`timeout`), the
  external signal, and secret redaction all work the same way as in `@merge-safely/provider-openai`.
- Retries: the SDK's own retries stay off (no `retryOptions`). The runner retries 408/409/425/429/5xx
  and network errors (system and undici codes) up to 3 times, honouring `RetryInfo.retryDelay` when
  the error body includes it. Errors are classified with the SDK's `ApiError` class. If the next retry
  would start after the seat deadline, the run stops at once with `error`.
- Known gap: when the deadline aborts a request that is in flight, its usage never comes back, so it
  does not reach `onUsage`. Requests are not streamed.
