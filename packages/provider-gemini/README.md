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

The client is created with `vertexai: false`, so an ambient `GOOGLE_GENAI_USE_VERTEXAI` cannot reroute
calls. Vertex AI (cloud credentials) will come later as a `cloud` adapter.

## Models

`validate` and `models` list `models.list()` and keep only `gemini-*` text models that support
`generateContent`, dropping embedding, TTS, image, live and similar models. Tiers come from the id:
`*-pro` is frontier, `*-flash` is mid, `*-flash-lite` is small. Context and output limits come from the
API's `inputTokenLimit` / `outputTokenLimit`. Prices come from a small local table of exact ids. For
Pro models the table uses the higher, above-200k-prompt band, so budgets err towards over-estimating.
Any other model is unpriced, and `maxUsd` cannot be enforced for it (the logger warns).

## Runner behaviour

- Each model turn is added back to the history unchanged. This keeps the thought signatures on
  function-call parts, which Gemini 3 needs when thinking is combined with function calling.
- Gemini often leaves function-call ids out. The runner makes up ids for its own bookkeeping and
  includes a `functionResponse.id` only when the model sent one.
- `seat.model.effort` becomes `thinkingConfig.thinkingLevel` on Gemini 3.x, and
  `thinkingConfig.thinkingBudget` on 2.5: minimal is 0 (128 on Pro, which cannot turn thinking off),
  low 1024, medium 8192, high 24576.
- Usage is streamed per response. `in` is `promptTokenCount - cachedContentTokenCount`, `cachedIn` is
  `cachedContentTokenCount`, and `out` is `candidatesTokenCount + thoughtsTokenCount`, since thinking
  is billed as output.
- Schema validation, invalid-submission retries (2, then `schema-invalid`), plain-text `extractJson`
  salvage, `maxTurns` / `maxUsd` (`budget-exceeded`, with recovery text), `deadlineMs` (`timeout`), the
  external signal, and secret redaction all work the same way as in `@merge-safely/provider-openai`.
- Retries: the SDK's own retries stay off (no `retryOptions`). The runner retries 408/429/5xx and
  network errors up to 3 times, honouring `RetryInfo.retryDelay` when the error body includes it.
