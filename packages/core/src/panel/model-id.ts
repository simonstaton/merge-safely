/**
 * Model id normalisation and matching: the single source of truth, shared by seating and (via re-export) the
 * registry, so a policy id, a catalog id and a registry id always compare the same way.
 *
 * Normalisation (case-insensitive): strips `[1m]`-style suffixes, `models/` and any `vendor/…/` path
 * (Gemini, Vertex publishers, OpenRouter), and Bedrock `anthropic.` / `us.anthropic.` style prefixes.
 * Matching: exact, or the catalog name followed by a date/version suffix (`-20260301`, `-2026-08-07`, `@20251101`,
 * `-20250805-v1:0`, `-preview-05-20`). Ollama-style `:tag` variants match only when `allowTag` is set, which callers
 * do for local providers only.
 */

/** Providers whose models run locally; only these get `:tag` matching and zero cost. */
export const LOCAL_PROVIDERS: readonly string[] = ["ollama", "lmstudio"];

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.includes(provider);
}

/** A local `:tag` that is actually served remotely (e.g. Ollama's `gpt-oss:120b-cloud`) is not free. */
export function isCloudTag(id: string): boolean {
  return /[-:]cloud$/i.test(id.trim());
}

const SUFFIX_TOKEN = /^(\d{2,8}|latest|preview|exp|v\d+(:\d+)?)$/;

export function normaliseModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]$/, "");
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/^(?:[a-z]{2,6}\.)?(?:anthropic|openai|google|meta|mistral|cohere|amazon)\./, "");
  return s;
}

/**
 * True when (already-normalised) `id` names catalog model `name`: equal, or `name` plus a date/version suffix,
 * or (with `allowTag`) `name:<tag>`. A suffix containing a word (`-mini`) never matches.
 */
export function modelIdMatches(id: string, name: string, opts: { allowTag?: boolean } = {}): boolean {
  if (id === name) return true;
  if (!id.startsWith(name) || id.length === name.length) return false;
  const sep = id[name.length];
  const rest = id.slice(name.length + 1);
  if (rest.length === 0) return false;
  if (sep === ":") return opts.allowTag === true;
  if (sep !== "-" && sep !== "@") return false;
  return rest.split("-").every((t) => SUFFIX_TOKEN.test(t));
}

/**
 * The catalog entry an id refers to: exact match first, then the longest catalog name the id extends.
 * `normalise` defaults to `normaliseModelId`; the CLI may pass the registry's (the same function).
 */
export function matchModelId<T extends { provider: string; name: string }>(
  models: readonly T[],
  id: string,
  opts: { normalise?: (id: string) => string } = {},
): T | undefined {
  const norm = opts.normalise ?? normaliseModelId;
  const want = norm(id);
  let best: T | undefined;
  let bestLen = -1;
  for (const m of models) {
    const n = norm(m.name);
    if (n === want) return m;
    if (n.length > bestLen && modelIdMatches(want, n, { allowTag: isLocalProvider(m.provider) })) {
      best = m;
      bestLen = n.length;
    }
  }
  return best;
}
