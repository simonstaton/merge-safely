# @merge-safely/providers

Connection kinds, connection storage, envelope encryption, the provider registry and model resolution.
No vendor SDKs: provider adapters live in `@merge-safely/provider-*` and are registered here.

## Inputs

**Connections file** (`$MERGE_SAFELY_HOME/connections.json`, default `~/.merge-safely/connections.json`):

```json
{
  "version": 1,
  "connections": [
    { "id": "anthropic-main", "provider": "anthropic", "kind": "api-key", "secretRef": { "env": "ANTHROPIC_API_KEY" } },
    { "id": "router", "provider": "openai-compatible", "kind": "openai-compatible",
      "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
    { "id": "openai-main", "provider": "openai", "kind": "api-key", "secretRef": { "encrypted": "v1:..." } },
    { "id": "key-in-file", "provider": "gemini", "kind": "api-key", "secretRef": { "file": "gemini.key" } }
  ]
}
```

A secret comes from exactly one of: `secret` (inline `ConnectionSecret`), `secretRef.env` / `apiKeyEnv`
(the value fills `apiKey`, or `accessToken` for `oauth`; compatible kinds take `baseUrl`/`headers` inline),
`secretRef.file` (plain value, or a JSON `ConnectionSecret`; `~/` expands to the home directory, other relative
paths resolve against the directory the connections file was opened from), or
`secretRef.encrypted` (decrypted with `MERGE_SAFELY_MASTER_KEY` or `opts.masterKey`). `cloud` and `subscription`
need no secret.

**Action / App inline map** (design 6.1): `{ [id]: { provider, apiKey? | apiKeyEnv?, baseUrl?, headers?, accessToken? | accessTokenEnv?, model?, runner?, kind? } }`.

Kind rules:
- An explicit `kind` always wins, and must be a kind the provider supports (for example `bedrock` supports only
  `cloud`, and `subscription` is Anthropic only).
- Otherwise, in order: `subscription: true` → `subscription` (an error when combined with `baseUrl`, `apiKey*` or
  `accessToken*`); bedrock/vertex/azure-openai → `cloud` (an error with a `baseUrl`); a `baseUrl`, a gateway name or
  ollama → `anthropic-compatible` for anthropic, else `openai-compatible`; `accessToken` → `oauth`;
  `apiKey` → `api-key`; `region` and the other cloud fields → `cloud`.
- Any field the chosen kind does not use (for example `accessToken` on `openai-compatible`, or `headers` on
  `api-key`) is an error that lists the fields. Nothing is dropped silently.
- An empty `apiKey` (an unset GitHub secret) is its own clear error.

Gateways: `openrouter`, `together`, `fireworks`, `groq` and `vllm` are normalised to provider `openai-compatible`,
with the vendor name kept in `label` and a default `baseUrl` filled in where one exists (vllm has none). The local
servers `ollama` and `lmstudio` keep their own provider ids (so the local presets in `@merge-safely/provider-compatible`
serve them) and default to `http://localhost:11434/v1` and `http://localhost:1234/v1`. File entries follow the same
provider/kind checks and normalisation.

**Strings:** `parseConnectionsInput` accepts an object or a JSON string. YAML is not parsed here, because parser
errors quote source lines that may hold keys. The Action and CLI parse YAML at the edge and pass the parsed object.

`parseConnectionsInput(obj, env)` accepts either shape (or a JSON string), returns good connections plus
`errors` that name ids, fields and env var names, never values.

## Saving

`saveConnectionsFile(path, connections, { masterKey?, envRefs?, env? })` writes atomically: a 0600 temp file is
fsynced and then renamed, and the directory is fsynced. A symlinked `connections.json` is written through, not
replaced. Secrets are encrypted when a master key is given, else written as `secretRef.env` for ids in `envRefs`
(with a warning when a `baseUrl` with userinfo or a query string, or `headers`, is stored next to it), else written
in plaintext with a warning. The merge-safely home directory (`.merge-safely` or `$MERGE_SAFELY_HOME`) is set to
0700, including when it already exists. Any other directory is left alone, with a warning if others can read it.

## Envelope encryption

`encryptSecret(secret, masterKey, connectionId)` → `v1:<base64 json>`. A random 32-byte data key seals the secret
(AES-256-GCM); the master key seals the data key (AES-256-GCM). Both bind the connection id as AAD, so a blob
moved to another record fails. Raw master keys are a 32-byte Buffer, exactly 64 hex characters, or `base64:<32 bytes>`. Every
other string is a passphrase (at least 12 characters), stretched with scrypt (N=2^15, r=8, p=1) using a salt stored
in the blob. Decryption requires 12-byte IVs and 16-byte tags, and scrypt parameters of N a power of two in
[2^14, 2^20], r = 8 and p in [1, 4]. Every failure is a `SecretDecryptError`. `generateMasterKey()` returns hex.
See `src/crypto.ts` for the exact field layout.

## Registry, catalog, resolution

- `createProviderRegistry([anthropic(), openai()])`. `forConnection(conn)` looks up `conn.provider`. For compatible
  kinds it falls back to the adapter registered as `openai-compatible` or `anthropic-compatible`. When neither exists
  it throws, naming the provider and the registered ids, and it also throws when the adapter does not accept the kind.
- `buildCatalog(registry, connections, { validate?, cache? })` never throws for one bad connection; problems
  are recorded with secrets masked, including userinfo and query values from `baseUrl`. `catalogLookup(catalog)` gives `(connectionId) => ModelInfo[]`.
- `resolveModelRef(selection, connections, catalog, { onWarning? })` → `ModelRef`, with fix hints.
- `redactConnection`, `describeConnection` (`anthropic-main (anthropic, api-key, key …k3Fd)`), `maskSecret`.
