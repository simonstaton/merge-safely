import { isIP } from "node:net";
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
import { findModel, pessimisticPricing, REGISTRY_VERSION } from "@merge-safely/registry";

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
 * SDK from picking up `OPENAI_API_KEY` from the environment. Throws for any other secret kind.
 */
export function withLocalDefaults(conn: Connection, defaultBaseUrl: string): Connection {
  if (conn.secret.kind !== "openai-compatible") throw new Error(unsupported(conn));
  const baseUrl = conn.secret.baseUrl?.trim() ? conn.secret.baseUrl : defaultBaseUrl;
  const api = conn.options?.api === "responses" ? "responses" : "chat";
  return { ...conn, options: { ...(conn.options ?? {}), api }, secret: { ...conn.secret, baseUrl } };
}

function unsupported(conn: Connection): string {
  return `connection kind "${conn.secret.kind}" is not supported by the ${conn.provider} local preset (connection ${conn.id}); use kind openai-compatible`;
}

function ipv4Private(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map(Number);
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

/**
 * True for a host on this machine or a private network: `localhost` / `*.localhost`, IPv4 loopback, RFC 1918 and
 * link-local ranges, IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10), and IPv4-mapped forms of these.
 * Hostnames that merely resolve to a private address (`gpu-box.lan`) are not trusted: opt in with `options.zeroCost`.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) return ipv4Private(h);
  if (kind === 6) {
    if (h === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped?.[1]) return ipv4Private(mapped[1]);
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  return false;
}

/**
 * Whether models on this connection are free. `options.zeroCost` (boolean) wins; otherwise only when the base URL
 * host is loopback or a private network address. A remote host (e.g. https://ollama.com/v1) is a paid service.
 */
export function isLocalConnection(conn: Connection): boolean {
  if (typeof conn.options?.zeroCost === "boolean") return conn.options.zeroCost;
  if (conn.secret.kind !== "openai-compatible") return false;
  try {
    return isPrivateHost(new URL(conn.secret.baseUrl).hostname);
  } catch {
    return false;
  }
}

/** A model that is not free: its own pricing, or the registry's pessimistic rate so budgets still enforce. */
function priced(model: ModelInfo): ModelInfo {
  const { zeroCost: _free, ...rest } = model;
  if (rest.pricing) return rest;
  return { ...rest, pricing: pessimisticPricing(), source: `${REGISTRY_VERSION}:pessimistic` };
}

/**
 * A model as served by a local preset. On a local connection: zero cost with no pricing, tier from the registry
 * entry for the preset's provider id when known, else "mid". A `-cloud` / `:cloud` tag (served remotely) and any
 * model on a non-local connection keep their pricing or get the pessimistic rate.
 */
export function asLocalModel(model: ModelInfo, local = true): ModelInfo {
  if (!local || isCloudTag(model.name)) return priced(model);
  const known = findModel(model.provider, model.name);
  const { pricing: _paid, ...rest } = model;
  return { ...rest, zeroCost: true, tier: known?.tier ?? "mid" };
}

/** A local OpenAI-compatible runtime (Ollama, LM Studio, llama.cpp server...) as a provider preset. */
export function localProvider(opts: LocalProviderOptions): ModelProvider {
  const { id, defaultBaseUrl, ...openaiOpts } = opts;
  const inner = openaiCompatibleProvider(openaiOpts);
  const prep = (conn: Connection) => withLocalDefaults(conn, defaultBaseUrl);
  const shape = (conn: Connection, m: ModelInfo) =>
    asLocalModel({ ...m, provider: conn.provider }, isLocalConnection(conn));
  return {
    id,
    connectionKinds: ["openai-compatible"],

    async validate(conn: Connection): Promise<ValidationResult> {
      if (conn.secret.kind !== "openai-compatible") return { ok: false, message: unsupported(conn) };
      const c = prep(conn);
      const v = await inner.validate(c);
      return v.models ? { ...v, models: v.models.map((m) => shape(c, m)) } : v;
    },

    async models(conn: Connection): Promise<ModelInfo[]> {
      const c = prep(conn);
      return (await inner.models(c)).map((m) => shape(c, m));
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts?: RunnerOptions): ModelRunner {
      const c = prep(conn);
      return inner.createRunner(c, asLocalModel(model, isLocalConnection(c)), runnerOpts);
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
