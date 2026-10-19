# @merge-safely/provider-compatible

Base-URL presets over the API runners, so `ProviderRegistry.forConnection` finds an adapter for every
compatible connection. Nothing here re-implements a transport: the OpenAI-compatible presets are the
`@merge-safely/provider-openai` Chat Completions runner and the Anthropic-compatible preset is the
`@merge-safely/provider-anthropic` Messages API (or Claude Code CLI) runner, pointed at `secret.baseUrl`.

```ts
import { createProviderRegistry } from "@merge-safely/providers";
import { allProviders } from "@merge-safely/provider-compatible";

const registry = createProviderRegistry(allProviders());
const provider = registry.forConnection(conn); // anthropic, openai, gemini, or one of the presets below
```

## Exports

| Export | Provider id | Kinds | Notes |
|---|---|---|---|
| `openaiCompatibleProvider(opts?)` | `openai-compatible` | `openai-compatible` | Re-exported from provider-openai. Chat Completions unless `options.api: "responses"`. |
| `anthropicCompatibleProvider(opts?)` | `anthropic-compatible` | `anthropic-compatible` | Delegates to `anthropicProvider()`. Uses the secret's `baseUrl`, `apiKey` and `headers`; `options.runner: "cli"` runs Claude Code with `ANTHROPIC_BASE_URL` set. |
| `ollamaProvider(opts?)` | `ollama` | `openai-compatible` | Default base URL `http://127.0.0.1:11434/v1`. No key. |
| `lmstudioProvider(opts?)` | `lmstudio` | `openai-compatible` | Default base URL `http://127.0.0.1:1234/v1`. No key. |
| `localProvider({ id, defaultBaseUrl, ...opts })` | any | `openai-compatible` | The generic local preset (llama.cpp server, Jan, ...). |
| `compatibleProviders(opts?)` | | | The four presets above. |
| `allProviders(opts?)` | | | `anthropic`, `openai`, `gemini` plus `compatibleProviders()`. Options: `{ anthropic?, openai?, gemini? }`. |

Local presets:
- accept only `openai-compatible` secrets: `validate` returns `ok: false`, and `models` / `createRunner` throw for any
  other kind, so an `api-key` secret is never sent to api.openai.com under a "local" (zero-cost) label;
- fill the default base URL when the secret's is empty, and send the `KEYLESS_PLACEHOLDER` key (never `OPENAI_API_KEY`
  from the environment);
- use Chat Completions unless the connection sets `options.api: "responses"`;
- report models under the connection's provider id, with the tier from the registry entry for that id when known,
  else `"mid"`.

**Zero cost rule.** Models are `zeroCost: true` (no pricing) only when the base URL host is local: `localhost` /
`*.localhost`, IPv4 loopback, RFC 1918 (10/8, 172.16/12, 192.168/16) and link-local (169.254/16), IPv6 `::1`,
unique-local `fc00::/7` and link-local `fe80::/10`. Any other host, for example `https://ollama.com/v1` or a
hostname like `gpu-box.lan` (not resolved), keeps the registry pricing or gets the pessimistic fallback, so budgets
and the ledger still enforce. `options.zeroCost: true` opts a self-hosted box in; `options.zeroCost: false` forces
pricing even on localhost. A `-cloud` / `:cloud` tag is served remotely and is always priced.

`anthropicCompatibleProvider` reports models under the connection's provider id too (the Anthropic adapter stamps
`anthropic`); pricing comes from the registry's Anthropic family.

## Gateways

Gateway names are normalised by `@merge-safely/providers`: `openrouter`, `together`, `fireworks`, `groq` and `vllm`
become provider `openai-compatible` (vendor kept in `label`, default `baseUrl` filled where one exists, vllm has none).
`ollama` and `lmstudio` keep their own ids and are served by the local presets. A `baseUrl` on an `anthropic`
connection makes it `anthropic-compatible`.

| Gateway | Served by | Default base URL |
|---|---|---|
| OpenRouter | `openai-compatible` | `https://openrouter.ai/api/v1` |
| Together | `openai-compatible` | `https://api.together.xyz/v1` |
| Groq | `openai-compatible` | `https://api.groq.com/openai/v1` |
| Fireworks | `openai-compatible` | `https://api.fireworks.ai/inference/v1` |
| vLLM | `openai-compatible` | none, give `baseUrl` |
| LM Studio | `lmstudio` | `http://localhost:1234/v1` |
| Ollama | `ollama` | `http://localhost:11434/v1` |
| Anthropic-compatible proxy | `anthropic` (provider `anthropic` + `baseUrl`) or `anthropic-compatible` | none, give `baseUrl` |

## Connection snippets

Action / App inline map (YAML, parsed at the edge):

```yaml
connections:
  openrouter:
    provider: openrouter
    apiKey: ${{ secrets.OPENROUTER_API_KEY }}
    model: anthropic/claude-sonnet-5-5
  together:
    provider: together
    apiKey: ${{ secrets.TOGETHER_API_KEY }}
  groq:
    provider: groq
    apiKey: ${{ secrets.GROQ_API_KEY }}
  fireworks:
    provider: fireworks
    apiKey: ${{ secrets.FIREWORKS_API_KEY }}
  vllm:
    provider: vllm
    baseUrl: http://vllm.internal:8000/v1
  ollama:
    provider: ollama            # no key; http://localhost:11434/v1
    model: qwen3-coder
  lmstudio:
    provider: lmstudio          # no key; http://localhost:1234/v1
  claude-proxy:
    provider: anthropic         # baseUrl makes it anthropic-compatible
    baseUrl: https://llm-proxy.internal/anthropic
    apiKey: ${{ secrets.LLM_PROXY_KEY }}
```

Connections file (`~/.merge-safely/connections.json`):

```json
{
  "version": 1,
  "connections": [
    { "id": "openrouter", "provider": "openrouter", "kind": "openai-compatible", "apiKeyEnv": "OPENROUTER_API_KEY" },
    { "id": "vllm", "provider": "openai-compatible", "kind": "openai-compatible", "baseUrl": "http://vllm.internal:8000/v1" },
    { "id": "ollama", "provider": "ollama", "kind": "openai-compatible" },
    { "id": "claude-proxy", "provider": "anthropic-compatible", "kind": "anthropic-compatible",
      "baseUrl": "https://llm-proxy.internal/anthropic", "apiKeyEnv": "LLM_PROXY_KEY",
      "headers": { "x-team": "platform" } }
  ]
}
```

Gateways that reject `strict` tool schemas are the default; set `options.strict: true` on a connection whose gateway
supports it. Model ids on gateways are passed through untouched (`openai/gpt-5`, `meta-llama/llama-3.3-70b`); pricing
comes from the registry family when the id is recognised, else the pessimistic fallback so budgets still enforce.
