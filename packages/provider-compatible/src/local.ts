import {
  type Connection,
  isCloudTag,
  type ModelInfo,
  type ModelProvider,
  type ModelRunner,
  type ProviderId,
  type RunnerOptions,
  type ValidationResult,
} from "@merge-safely/core";
import { type OpenAIProviderOptions, openaiCompatibleProvider } from "@merge-safely/provider-openai";
import { findModel, withPricing } from "@merge-safely/registry";

/** Ollama's OpenAI-compatible endpoint on the default port. */
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
/** LM Studio's OpenAI-compatible server on the default port. */
export const LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

export interface LocalProviderOptions extends OpenAIProviderOptions {
  /** Provider id to register under, e.g. "ollama". */
  id: ProviderId;
  /** Used when the connection's secret has no (or an empty) base URL. */
  defaultBaseUrl: string;
}

/**
 * The connection a local preset actually uses: the default base URL when the secret has none, and the Chat
 * Completions wire API unless the connection explicitly asks for `options.api: "responses"`. No API key is
 * added: the OpenAI client sends `KEYLESS_PLACEHOLDER` for a keyless compatible secret, which also keeps the
 * SDK from picking up `OPENAI_API_KEY` from the environment.
 */
export function withLocalDefaults(conn: Connection, defaultBaseUrl: string): Connection {
  if (conn.secret.kind !== "openai-compatible") return conn;
  const baseUrl = conn.secret.baseUrl?.trim() ? conn.secret.baseUrl : defaultBaseUrl;
  const api = conn.options?.api === "responses" ? "responses" : "chat";
  return { ...conn, options: { ...(conn.options ?? {}), api }, secret: { ...conn.secret, baseUrl } };
}

/**
 * A model served by a local runtime: zero cost (no pricing at all) and tier "mid" unless the registry's local
 * table knows the family. A `-cloud` / `:cloud` tag is served remotely by the vendor and is never free: it keeps its
 * pricing, or gets the registry's pessimistic rate so budgets still enforce.
 */
export function asLocalModel(model: ModelInfo): ModelInfo {
  if (isCloudTag(model.name)) {
    const { zeroCost: _free, ...paid } = model;
    return withPricing(paid);
  }
  const known = findModel("ollama", model.name);
  const { pricing: _paid, ...rest } = model;
  return { ...rest, zeroCost: true, tier: known?.tier ?? "mid" };
}

/** A local OpenAI-compatible runtime (Ollama, LM Studio, llama.cpp server...) as a provider preset. */
export function localProvider(opts: LocalProviderOptions): ModelProvider {
  const { id, defaultBaseUrl, ...openaiOpts } = opts;
  const inner = openaiCompatibleProvider(openaiOpts);
  const prep = (conn: Connection) => withLocalDefaults(conn, defaultBaseUrl);
  return {
    id,
    connectionKinds: ["openai-compatible"],

    async validate(conn: Connection): Promise<ValidationResult> {
      const v = await inner.validate(prep(conn));
      return v.models ? { ...v, models: v.models.map(asLocalModel) } : v;
    },

    async models(conn: Connection): Promise<ModelInfo[]> {
      return (await inner.models(prep(conn))).map(asLocalModel);
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts?: RunnerOptions): ModelRunner {
      return inner.createRunner(prep(conn), asLocalModel(model), runnerOpts);
    },
  };
}

/** Ollama (provider id "ollama"), default base URL http://127.0.0.1:11434/v1, no key required. */
export function ollamaProvider(opts: OpenAIProviderOptions = {}): ModelProvider {
  return localProvider({ ...opts, id: "ollama", defaultBaseUrl: OLLAMA_BASE_URL });
}

/** LM Studio (provider id "lmstudio"), default base URL http://127.0.0.1:1234/v1, no key required. */
export function lmstudioProvider(opts: OpenAIProviderOptions = {}): ModelProvider {
  return localProvider({ ...opts, id: "lmstudio", defaultBaseUrl: LMSTUDIO_BASE_URL });
}
