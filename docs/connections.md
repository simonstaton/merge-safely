# Connections

A connection is one model backend you have credentials for. You bring the credentials; Merge Safely calls the provider directly from your runner and never proxies tokens. An installation can hold several connections at once. Policy refers to them by `id`.

The authoritative format is in [`packages/providers/README.md`](../packages/providers/README.md).

## Connection kinds

| Kind | Providers | Secret | Notes |
|---|---|---|---|
| `api-key` | Anthropic, OpenAI, Gemini | `{ apiKey }` | The default. Validated with a models-list call. |
| `openai-compatible` | OpenRouter, Together, Fireworks, Groq, vLLM, Ollama, LM Studio, any gateway | `{ baseUrl, apiKey?, headers? }` | Anything that speaks the OpenAI API. Chat Completions by default. |
| `anthropic-compatible` | Any gateway that speaks the Anthropic Messages API | `{ baseUrl, apiKey, headers? }` | Also how the Claude Code CLI runner works behind a proxy. |
| `oauth` | Anthropic, OpenAI | `{ accessToken, refreshToken?, expiresAt? }` | Bearer token. |
| `subscription` | Anthropic (Claude Code login) | none stored | Opt-in, off by default. Always uses the Claude Code CLI runner. See the caveat below. |

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

`subscription` connections and keyless local servers need no secret.

Environment references are the simplest safe option: the file holds a variable name, and the value lives in your shell, keychain or secret manager.

The file is written atomically with mode `0600` (temp file, fsync, rename). The merge-safely home directory is created `0700`, and an existing home that other users can read is tightened to `0700` on the next write (a connections file elsewhere only gets a warning). Loading warns when the file is readable by other users. `connect` replaces an entry with the same id and leaves every other entry exactly as stored.

How `connect` stores the secret, in order of precedence:

1. `--api-key-env NAME`: only `secretRef: { env: NAME }` is written, even when `MERGE_SAFELY_MASTER_KEY` is set. Nothing secret is stored.
2. `MERGE_SAFELY_MASTER_KEY` set: the secret is written as a `secretRef.encrypted` blob.
3. Otherwise: plaintext in the `0600` file, with a warning.

Connections that hold no secret (`subscription`, keyless local servers such as Ollama or LM Studio) are always written as plain records, never encrypted, so they load without the master key.

## Encryption at rest

Set `MERGE_SAFELY_MASTER_KEY` and secrets are stored as `secretRef.encrypted` blobs (`v1:…`), except for connections made with `--api-key-env` (an env reference wins) and connections with no secret at all.

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

Fields: `provider`, `kind`, `model`, `runner`, `label`, then the fields of the kind: `apiKey` or `apiKeyEnv` (`api-key`); `baseUrl`, `apiKey` or `apiKeyEnv`, `headers` (compatible kinds); `accessToken` or `accessTokenEnv`, `refreshToken`, `expiresAt` (`oauth`); `subscription`, `credentialFileRef` (`subscription`). The App's setup page and the CLI's `connect` build the same shape.

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

1. `subscription: true` → `subscription` (an error when combined with `baseUrl`, `apiKey*` or `accessToken*`).
2. A `baseUrl`, a gateway name (`openrouter`, `together`, `fireworks`, `groq`, `vllm`), a local server (`ollama`, `lmstudio`), or `provider: openai-compatible` / `anthropic-compatible` → `anthropic-compatible` for `provider: anthropic` or `anthropic-compatible`, otherwise `openai-compatible`.
3. `accessToken` or `accessTokenEnv` → `oauth`.
4. `apiKey` or `apiKeyEnv` → `api-key`.

An explicit `kind` always wins and must be one the provider supports (`subscription` is Anthropic only). A field the chosen kind does not use is an error that names the field; nothing is dropped silently. An empty `apiKey`, which is what an unset GitHub secret looks like, is its own clear error.

Gateway names are normalised: `openrouter`, `together`, `fireworks`, `groq` and `vllm` become `provider: openai-compatible`, with the vendor name kept as the label and the vendor's base URL filled in (vLLM has none, so give `baseUrl`). `ollama` and `lmstudio` keep their own provider ids, so the local presets serve them, and default to `http://localhost:11434/v1` and `http://localhost:1234/v1`.

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

The CLI runner drives `claude -p --output-format stream-json` with read-only, allowlisted tools (`Read`, `Grep`, `Glob`, and `Bash` limited to an `ms-git` wrapper plus the policy's allowed commands) and builds the audit from the CLI's own tool-use events. It is selected by `runner: cli` on any Anthropic kind, and always for `subscription`. The `claude` binary must be on the runner's `PATH` (override it with `options.claudeBinary`). Its git access needs a POSIX shell.

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

The child runs with `--safe-mode` (no `CLAUDE.md`, skills, hooks, plugins, MCP servers or custom agents from the checkout), `--restricted` (file tools confined to the checkout), a replaced system prompt and `--permission-mode dontAsk`. It gets an empty temporary `HOME`, so it cannot read host credentials, and no `ANTHROPIC_*` or `CLAUDE_*` variable from your environment. See [security.md](security.md).

### Claude subscription

```bash
merge-safely connect anthropic --subscription --id claude-sub
```

```json
{ "id": "claude-sub", "provider": "anthropic", "kind": "subscription", "secret": { "kind": "subscription" } }
```

This runs reviews on **your personal Claude login** through the Claude Code CLI. Whether automated use of a consumer subscription is allowed is a terms-of-service question for you, the installing user, not for this project. It is off unless you create such a connection on purpose.

What changes under a subscription:

- Models are marked zero cost. Dollar ceilings never trip and no dollar cap is passed to the CLI. The plan's usage window is the real limit. See [budgets.md](budgets.md#subscription-connections).
- Your real `HOME` is used, because that is where the login lives. `credentialFileRef` on the connection points `CLAUDE_CONFIG_DIR` at a dedicated config directory instead.
- `validate` only checks that `claude --version` runs; it cannot tell whether you are logged in.
- A policy-allowed test command runs the PR's code as your user and could read your Claude credentials or anything else in your home. Only allow commands under a subscription for repositories and authors you trust, or run the gate in a container.

### OpenAI

```bash
merge-safely connect openai --api-key-env OPENAI_API_KEY
```

```yaml
openai-main: { provider: openai, apiKey: "${{ secrets.OPENAI_API_KEY }}" }
```

Uses the Responses API with `store: false`. Set `options.api` to `"chat"` on the connection record to use Chat Completions instead. The adapter never reads `OPENAI_API_KEY`, `OPENAI_BASE_URL` or `OPENAI_LOG` from the environment on its own.

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

Defaults to `http://localhost:11434/v1`. No key needed. Pick a model with tool support. LM Studio (`provider: lmstudio`, `http://localhost:1234/v1`) is the same.

```json
{ "id": "ollama-main", "provider": "ollama", "kind": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "defaultModel": "qwen2.5-coder" }
```

Local models are zero cost only when the base URL host is on this machine or a private network: `localhost`, loopback, RFC 1918, link-local and IPv6 unique-local addresses. A remote host (for example `https://ollama.com/v1`) or a hostname that merely resolves to a private address (`gpu-box.lan`) is priced, from the registry or at the pessimistic fallback rate, and so are `-cloud` / `:cloud` model tags. Set `options.zeroCost: true` on the connection record to opt a self-hosted box in, or `false` to force pricing on localhost.

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
merge-safely connect openai-compatible --id vllm --base-url http://vllm.internal:8000/v1 --api-key-env VLLM_KEY
```

```yaml
vllm: { provider: vllm, baseUrl: "http://vllm.internal:8000/v1" }
```

A keyless compatible connection sends a placeholder key. It never falls back to `OPENAI_API_KEY`, which would hand your OpenAI key to a third party. Strict tool schemas are only sent to gateways whose connection sets `options.strict: true`. Gateway model ids (`openai/gpt-5`, `meta-llama/llama-3.3-70b`) are passed through untouched; they are priced from the registry family when recognised, else at the pessimistic fallback rate.

## Validation

`merge-safely connect` and `merge-safely connections test` (CLI), each run (Action) and the setup page (App) validate each connection with a cheap call and list the models it can reach. A compatible endpoint that has no `/models` route is treated as reachable with no model list; name the model yourself with `--model` or in the policy. In the CLI, an entry that cannot even be loaded (its env variable is not set, or it is encrypted and the master key is missing or wrong) is reported as a `FAIL` with the reason, and the command exits 2.

`merge-safely run` validates connections before seating (15 s each). A dead connection the policy names stops the run with `error [CONNECTION_UNREACHABLE]` naming it and the fix; under automatic model choice a dead connection is skipped with a warning, and the run stops only when none is left. A connection that fails mid-run marks its seats `error` and the check run names the connection. It is never skipped silently.

## Fallback and decorrelation

Two policy settings make several connections work together:

```yaml
models:
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }
  decorrelate: true
```

- **Fallback.** When a seat's primary connection is rate limited or down, the seat runs on `models.fallback` instead, if it still fits the budget. The seat's run and the cost breakdown record that the fallback served it.
- **Decorrelation.** With more than one reachable connection, hunter seats alternate across connections, and judges prefer an equally strong connection other than the one serving most hunters. Different model families make different mistakes, so a panel drawn from several is less likely to miss the same thing twice. Judges are never weaker than the strongest model on offer.

See [policy.md](policy.md#models) for the full selection rules.
