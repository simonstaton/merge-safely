# Connections

A connection is one model backend you have credentials for. You bring the credentials; Merge Safely calls the provider directly from your runner and never proxies tokens. An installation can hold several connections at once. Policy refers to them by `id`.

The authoritative format is in [`packages/providers/README.md`](../packages/providers/README.md).

## Connection kinds

| Kind | Providers | Secret | Notes |
|---|---|---|---|
| `api-key` | Anthropic, OpenAI, Gemini | `{ apiKey }` | The default. Validated with a models-list call. |
| `openai-compatible` | OpenRouter, Together, Fireworks, Groq, vLLM, Ollama, LM Studio, any gateway | `{ baseUrl, apiKey?, headers? }` | Anything that speaks the OpenAI API. |
| `anthropic-compatible` | Any gateway that speaks the Anthropic Messages API | `{ baseUrl, apiKey, headers? }` | Needed for the Claude Code CLI runner behind a proxy. |
| `oauth` | Anthropic, OpenAI | `{ accessToken, refreshToken?, expiresAt? }` | Bearer token. |
| `cloud` | Bedrock, Vertex, Azure OpenAI | none stored | Not yet shipped. |
| `subscription` | Anthropic (Claude Code login) | none stored | Opt-in, off by default. See the caveat below. |

## Where connections live

| Surface | Where |
|---|---|
| CLI | `$MERGE_SAFELY_HOME/connections.json` (default `~/.merge-safely/connections.json`), written by `merge-safely connect`. |
| Action | The `connections` input, a YAML map in the workflow. Secrets come from GitHub secrets. |
| App | The setup page. Secrets are encrypted in the App's database. |

## The connections file

```json
{
  "version": 1,
  "connections": [
    { "id": "anthropic-main", "provider": "anthropic", "kind": "api-key", "secretRef": { "env": "ANTHROPIC_API_KEY" } },
    {
      "id": "router",
      "provider": "openai-compatible",
      "kind": "openai-compatible",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    { "id": "openai-main", "provider": "openai", "kind": "api-key", "secretRef": { "encrypted": "v1:..." } },
    { "id": "gemini-main", "provider": "gemini", "kind": "api-key", "secretRef": { "file": "gemini.key" } }
  ]
}
```

Each connection takes its secret from exactly one of:

| Field | Meaning |
|---|---|
| `secretRef.env` or `apiKeyEnv` | Read from an environment variable at run time. The value fills `apiKey` (or `accessToken` for `oauth`). Compatible kinds take `baseUrl` and `headers` inline. |
| `secretRef.file` | Read from a file: a plain value, or a JSON secret object. `~/` expands to your home directory. Other relative paths resolve against the directory of the connections file. |
| `secretRef.encrypted` | An encrypted blob, decrypted with `MERGE_SAFELY_MASTER_KEY`. |
| `secret` | The secret inline, as an object. Avoid this outside tests. |

`cloud` and `subscription` need no secret.

Environment references are the simplest safe option: the file holds a variable name, and the value lives in your shell, keychain or secret manager.

The file is written atomically with mode `0600`, and the `.merge-safely` directory is kept at `0700`. Without a master key or an env reference, `connect` writes the secret in plaintext and warns you.

## Encryption at rest

Set `MERGE_SAFELY_MASTER_KEY` and secrets are stored as `secretRef.encrypted` blobs (`v1:…`).

- Envelope encryption. A random 32-byte data key seals the secret with AES-256-GCM. The master key seals the data key with AES-256-GCM.
- Both layers bind the connection id as associated data, so a blob copied to another connection fails to decrypt.
- The master key is 64 hex characters, `base64:` followed by 32 bytes, or a passphrase of at least 12 characters (stretched with scrypt).
- Generate one with `openssl rand -hex 32`.

The App uses the same scheme with a data key per connection. Secrets are never returned by any API after creation and are redacted from errors and logs.

## The Action's `connections` input

A YAML map of connection id to fields:

```yaml
connections: |
  anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
  openai-main:    { provider: openai,    apiKey: "${{ secrets.OPENAI_API_KEY }}" }
```

Fields: `provider`, `apiKey` or `apiKeyEnv`, `baseUrl`, `headers`, `accessToken` or `accessTokenEnv`, `model`, `runner`, `kind`, `subscription`.

To keep secrets out of the input string altogether, set them as step environment variables and refer to them with `apiKeyEnv`:

```yaml
      - uses: simonstaton/merge-safely@v0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
```

How the kind is chosen when you do not set `kind`:

1. `subscription: true` → `subscription`.
2. `bedrock`, `vertex`, `azure-openai` → `cloud`.
3. A `baseUrl`, a gateway name (`openrouter`, `together`, `fireworks`, `groq`, `lmstudio`, `vllm`) or `ollama` → `anthropic-compatible` for `provider: anthropic`, otherwise `openai-compatible`.
4. `accessToken` → `oauth`.
5. `apiKey` → `api-key`.

An explicit `kind` always wins and must be one the provider supports. A field the chosen kind does not use is an error that names the field; nothing is dropped silently. An empty `apiKey`, which is what an unset GitHub secret looks like, is its own clear error.

Errors name connection ids, fields and environment variable names. They never contain values.

## Examples

### Anthropic API key

```bash
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY
```

```yaml
anthropic-main: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

Uses the Messages API runner with the shared read-only tool set.

### Claude Code CLI runner

The CLI runner drives `claude -p` with read-only, allowlisted tools and builds the audit from the CLI's own tool-use events. It gives the richest investigation. The `claude` binary must be on the runner's `PATH`.

```bash
merge-safely connect anthropic --api-key-env ANTHROPIC_API_KEY --runner cli
```

```yaml
anthropic-cli: { provider: anthropic, apiKey: "${{ secrets.ANTHROPIC_API_KEY }}", runner: cli }
```

```json
{ "id": "anthropic-cli", "provider": "anthropic", "kind": "api-key",
  "secretRef": { "env": "ANTHROPIC_API_KEY" }, "options": { "runner": "cli" } }
```

The child process gets an empty temporary `HOME`, so it cannot read host credentials. See [security.md](security.md).

### Claude subscription

```bash
merge-safely connect anthropic --subscription
```

```json
{ "id": "claude-sub", "provider": "anthropic", "kind": "subscription" }
```

This runs reviews on **your personal Claude login** through the Claude Code CLI. Whether automated use of a consumer subscription is allowed is a terms-of-service question for you, the installing user, not for this project. It is off unless you create such a connection on purpose.

What changes under a subscription:

- Models are marked zero cost. Dollar ceilings never trip. The plan's usage window is the real limit. See [budgets.md](budgets.md#subscription-connections).
- Your real `HOME` is used, because that is where the login lives. A secret file reference can point `CLAUDE_CONFIG_DIR` at a dedicated config directory.
- A policy-allowed test command runs the PR's code as your user and could read your Claude credentials or anything else in your home. Only allow commands under a subscription for repositories and authors you trust, or run the gate in a container.

### OpenAI

```bash
merge-safely connect openai --api-key-env OPENAI_API_KEY
```

```yaml
openai-main: { provider: openai, apiKey: "${{ secrets.OPENAI_API_KEY }}" }
```

Uses the Responses API with `store: false`. Set `options.api` to `"chat"` on the connection record to use Chat Completions instead.

### Gemini

```bash
merge-safely connect gemini --api-key-env GEMINI_API_KEY
```

```yaml
gemini-main: { provider: gemini, apiKey: "${{ secrets.GEMINI_API_KEY }}" }
```

A Google AI Studio key against the Gemini Developer API. The adapter never reads `GOOGLE_API_KEY`, `GEMINI_API_KEY` or Vertex settings from the environment on its own; only the key you connect is used.

### OpenRouter

```bash
merge-safely connect openrouter --api-key-env OPENROUTER_API_KEY
```

```yaml
router: { provider: openrouter, apiKey: "${{ secrets.OPENROUTER_API_KEY }}" }
```

Normalised to `provider: openai-compatible` with base URL `https://openrouter.ai/api/v1`. Model ids look like `openai/gpt-5` or `anthropic/claude-sonnet-4.5`. Together, Fireworks and Groq work the same way with their own names.

Budgets are always enforced against Merge Safely's own ledger, never against the provider's account usage figure.

### Ollama

```bash
merge-safely connect ollama --model qwen2.5-coder
```

```yaml
local: { provider: ollama, model: qwen2.5-coder }
```

Defaults to `http://localhost:11434/v1`. No key needed. Pick a model with tool support. Local models are priced at zero. LM Studio (`provider: lmstudio`, `http://localhost:1234/v1`) is the same.

A local model on the Actions runner is not practical. Use local connections from the CLI or a self-hosted App.

### Anthropic-compatible proxy

For a gateway that speaks the Anthropic Messages API, for example a corporate proxy in front of Anthropic or a cloud endpoint:

```bash
merge-safely connect anthropic-compatible --base-url https://llm-gateway.internal.example/anthropic --api-key-env GATEWAY_KEY
```

```yaml
gateway: { provider: anthropic, baseUrl: "https://llm-gateway.internal.example/anthropic", apiKeyEnv: GATEWAY_KEY }
```

`provider: anthropic` with a `baseUrl` becomes `kind: anthropic-compatible`. Both Anthropic runners work through it; the CLI runner receives it as `ANTHROPIC_BASE_URL`. If the gateway expects a bearer token rather than `x-api-key`, set `options.authHeader: "bearer"` on the connection record.

### Any OpenAI-compatible endpoint

```bash
merge-safely connect openai-compatible --base-url https://api.together.xyz/v1 --api-key-env TOGETHER_API_KEY
```

A keyless compatible connection sends a placeholder key. It never falls back to `OPENAI_API_KEY`, which would hand your OpenAI key to a third party.

## Validation

`merge-safely connections test` (CLI), the first run (Action) and the setup page (App) validate each connection with a cheap call and list the models it can reach. A failing connection marks its seats `error` and the check run names the connection. It is never skipped silently.

## Fallback and decorrelation

Two policy settings make several connections work together:

```yaml
models:
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }
  decorrelate: true
```

- **Fallback.** When a seat's primary connection is rate limited or down, the seat runs on `models.fallback` instead. The verdict records which seats used it.
- **Decorrelation.** With more than one reachable connection, hunter seats alternate across connections, and judges prefer a connection other than the one serving most hunters. Different model families make different mistakes, so a panel drawn from several is less likely to miss the same thing twice. Judges are never weaker than the strongest model on offer.

See [policy.md](policy.md#models) for the full selection rules.
