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
`secretRef.file` (plain value, or a JSON `ConnectionSecret`; relative to the connections file), or
`secretRef.encrypted` (decrypted with `MERGE_SAFELY_MASTER_KEY` or `opts.masterKey`). `cloud` and `subscription`
need no secret.

**Action / App inline map** (design 6.1): `{ [id]: { provider, apiKey? | apiKeyEnv?, baseUrl?, headers?, accessToken?, model?, runner?, kind? } }`.
Kind inference: `baseUrl` + anthropic → `anthropic-compatible`; `baseUrl` + anything else → `openai-compatible`;
`subscription: true` (anthropic only) → `subscription`; `accessToken` → `oauth`; `apiKey` → `api-key`;
bedrock/vertex/azure-openai or `region` → `cloud`. An empty `apiKey` (an unset GitHub secret) is a clear error.

`parseConnectionsInput(obj, env)` accepts either shape (or a JSON string), returns good connections plus
`errors` that name ids, fields and env var names, never values.

## Saving

`saveConnectionsFile(path, connections, { masterKey?, envRefs? })` writes atomically with mode 0600 (dir 0700):
encrypted when a master key is given, else `secretRef.env` for ids in `envRefs`, else plaintext with a warning.

## Envelope encryption

`encryptSecret(secret, masterKey, connectionId)` → `v1:<base64 json>`. A random 32-byte data key seals the secret
(AES-256-GCM); the master key seals the data key (AES-256-GCM). Both bind the connection id as AAD, so a blob
moved to another record fails. The master key is 32 bytes as hex/base64/Buffer, or a passphrase (≥12 chars)
stretched with scrypt (N=2^15, r=8, p=1) using a per-blob salt stored in the blob. `generateMasterKey()` gives hex.
See `src/crypto.ts` for the exact field layout.

## Registry, catalog, resolution

- `createProviderRegistry([anthropic(), openai()])`; `forConnection(conn)` throws naming the provider and the
  registered ids, or the accepted kinds.
- `buildCatalog(registry, connections, { validate?, cache? })` never throws for one bad connection; problems
  are recorded with secrets masked. `catalogLookup(catalog)` gives `(connectionId) => ModelInfo[]`.
- `resolveModelRef(selection, connections, catalog, { onWarning? })` → `ModelRef`, with fix hints.
- `redactConnection`, `describeConnection` (`anthropic-main (anthropic, api-key, key …k3Fd)`), `maskSecret`.
