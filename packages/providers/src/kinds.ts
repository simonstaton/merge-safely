/**
 * Which connection kinds each provider accepts, gateway-name normalisation, and kind inference for the
 * inline (Action/App) connection shape.
 */
import type { ConnectionKind, ProviderId } from "@merge-safely/core";
import { CONNECTION_KINDS, type InlineConnection } from "./schema.js";

/** Cloud providers use ambient cloud identity; they never take a baseUrl or key in the inline shape. */
export const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["bedrock", "vertex", "azure-openai"]);

/**
 * Well-known OpenAI-compatible gateways. Connections naming them are normalised to provider
 * `openai-compatible` (the vendor name is kept in `label`). The value is the default base URL, if any.
 */
export const OPENAI_COMPATIBLE_GATEWAYS: Readonly<Record<string, string | undefined>> = {
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  groq: "https://api.groq.com/openai/v1",
  lmstudio: "http://localhost:1234/v1",
  vllm: undefined,
};

/** Ollama keeps its own provider id (a dedicated preset registers it) but speaks the OpenAI API. */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

const PROVIDER_KINDS: Readonly<Record<string, readonly ConnectionKind[]>> = {
  anthropic: ["api-key", "oauth", "subscription", "anthropic-compatible"],
  "anthropic-compatible": ["anthropic-compatible"],
  openai: ["api-key", "oauth", "openai-compatible"],
  "openai-compatible": ["openai-compatible"],
  gemini: ["api-key", "oauth"],
  ollama: ["openai-compatible"],
  bedrock: ["cloud"],
  vertex: ["cloud"],
  "azure-openai": ["cloud"],
  ...Object.fromEntries(Object.keys(OPENAI_COMPATIBLE_GATEWAYS).map((g) => [g, ["openai-compatible"] as const])),
};

/** Kinds a provider id accepts. Unknown providers accept every kind except `subscription` (Anthropic only). */
export function allowedKindsForProvider(provider: ProviderId): readonly ConnectionKind[] {
  return PROVIDER_KINDS[provider] ?? CONNECTION_KINDS.filter((k) => k !== "subscription");
}

export function checkKindForProvider(provider: ProviderId, kind: ConnectionKind): string | undefined {
  const allowed = allowedKindsForProvider(provider);
  if (allowed.includes(kind)) return undefined;
  return `provider ${provider} does not support kind ${kind} (supported: ${allowed.join(", ")})`;
}

export function isGateway(provider: ProviderId): boolean {
  return Object.hasOwn(OPENAI_COMPATIBLE_GATEWAYS, provider);
}

/** Map a gateway name to the provider that serves it. Returns the provider and a label to keep the vendor name. */
export function normaliseProvider(
  provider: ProviderId,
  label: string | undefined,
): { provider: ProviderId; label: string | undefined; defaultBaseUrl: string | undefined } {
  if (isGateway(provider)) {
    return {
      provider: "openai-compatible",
      label: label ?? provider,
      defaultBaseUrl: OPENAI_COMPATIBLE_GATEWAYS[provider],
    };
  }
  if (provider === "ollama") return { provider, label, defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL };
  return { provider, label, defaultBaseUrl: undefined };
}

const COMMON_FIELDS = ["provider", "kind", "model", "runner", "label"] as const;

/** Inline fields each kind uses. Anything else present on an entry is an error, never silently dropped. */
export const KIND_FIELDS: Readonly<Record<ConnectionKind, readonly (keyof InlineConnection)[]>> = {
  "api-key": ["apiKey", "apiKeyEnv"],
  "openai-compatible": ["baseUrl", "apiKey", "apiKeyEnv", "headers"],
  "anthropic-compatible": ["baseUrl", "apiKey", "apiKeyEnv", "headers"],
  oauth: ["accessToken", "accessTokenEnv", "refreshToken", "expiresAt"],
  cloud: ["region", "projectOrResource", "credentialsRef"],
  subscription: ["subscription", "credentialFileRef"],
};

/** Fields present on `c` that `kind` does not use. `subscription: false` is harmless and allowed everywhere. */
export function unexpectedInlineFields(c: InlineConnection, kind: ConnectionKind): string[] {
  const used = new Set<string>([...COMMON_FIELDS, ...KIND_FIELDS[kind]]);
  return Object.entries(c)
    .filter(([k, v]) => v !== undefined && !used.has(k) && !(k === "subscription" && v === false))
    .map(([k]) => k);
}

const has = (c: InlineConnection, ...keys: (keyof InlineConnection)[]) => keys.filter((k) => c[k] !== undefined);

/**
 * Infer the connection kind of an inline entry (design 6.1). An explicit `kind` always wins and is checked
 * against the provider. Conflicting signals are errors rather than guesses.
 */
export function inferConnectionKind(c: InlineConnection): ConnectionKind | { error: string } {
  let kind: ConnectionKind;
  if (c.kind) {
    kind = c.kind;
  } else if (c.subscription === true) {
    if (c.apiKey !== undefined && c.apiKey.trim() === "") {
      return { error: "apiKey is empty; a subscription connection takes no apiKey, remove it" };
    }
    const conflicts = has(c, "baseUrl", "apiKey", "apiKeyEnv", "accessToken", "accessTokenEnv");
    if (conflicts.length) return { error: `subscription: true cannot be combined with ${conflicts.join(", ")}` };
    kind = "subscription";
  } else if (CLOUD_PROVIDERS.has(c.provider)) {
    if (c.baseUrl !== undefined) {
      return {
        error: `${c.provider} connections are kind cloud and take no baseUrl; for a gateway in front of it use provider openai-compatible (or set kind explicitly)`,
      };
    }
    kind = "cloud";
  } else if (
    c.baseUrl !== undefined ||
    isGateway(c.provider) ||
    c.provider === "ollama" ||
    c.provider === "openai-compatible" ||
    c.provider === "anthropic-compatible"
  ) {
    kind =
      c.provider === "anthropic" || c.provider === "anthropic-compatible"
        ? "anthropic-compatible"
        : "openai-compatible";
  } else if (has(c, "accessToken", "accessTokenEnv").length) {
    if (has(c, "apiKey", "apiKeyEnv").length) return { error: "give either apiKey or accessToken, not both" };
    kind = "oauth";
  } else if (has(c, "apiKey", "apiKeyEnv").length) {
    kind = "api-key";
  } else if (has(c, "region", "projectOrResource", "credentialsRef").length) {
    kind = "cloud";
  } else {
    return { error: "cannot infer the connection kind: give apiKey, apiKeyEnv, baseUrl, accessToken or kind" };
  }
  const bad = checkKindForProvider(c.provider, kind);
  return bad ? { error: bad } : kind;
}
