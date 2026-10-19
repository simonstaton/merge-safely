import type { Connection, ConnectionRecord, ModelInfo, ModelRef, ModelSelection } from "@merge-safely/core";
import type { Catalog } from "./catalog.js";
import { maskSecret } from "./mask.js";

export interface ResolveOptions {
  /** Receives non-fatal warnings (e.g. an unknown model accepted because the catalog is empty). */
  onWarning?: (message: string) => void;
}

type CatalogLike = Catalog | ((connectionId: string) => ModelInfo[]);

function lookup(catalog: CatalogLike, id: string): ModelInfo[] {
  return typeof catalog === "function" ? catalog(id) : (catalog.byConnection.get(id) ?? []);
}

/**
 * Turn a policy model selection (`{ connection, model, effort? }`) into a `ModelRef`.
 * Throws with a fix hint when the connection is unknown, or when the model is not in that connection's
 * non-empty catalog. An empty catalog (discovery failed or the provider lists nothing) lets the name through
 * with a warning, since budgets then fall back to pessimistic pricing.
 */
export function resolveModelRef(
  sel: ModelSelection,
  connections: ReadonlyArray<Connection | ConnectionRecord>,
  catalog: CatalogLike,
  opts: ResolveOptions = {},
): ModelRef {
  const conn = connections.find((c) => c.id === sel.connection);
  if (!conn) {
    const known = connections.map((c) => c.id);
    throw new Error(
      `policy refers to connection "${sel.connection}", which does not exist. Known connections: ${
        known.length ? known.join(", ") : "none"
      }. Fix: add it with \`merge-safely connect <provider>\` (or the Action \`connections\` input) or change the policy.`,
    );
  }
  const models = lookup(catalog, conn.id);
  let name = sel.model;
  if (models.length === 0) {
    opts.onWarning?.(
      `connection ${conn.id} has no known models; using "${sel.model}" unchecked (pricing unknown, budgets use the fallback rate)`,
    );
  } else {
    const exact = models.find((m) => m.name === sel.model);
    const loose = exact ?? models.find((m) => m.name.toLowerCase() === sel.model.toLowerCase());
    if (!loose) {
      const sample = models.slice(0, 10).map((m) => m.name);
      throw new Error(
        `model "${sel.model}" is not available on connection ${conn.id} (${conn.provider}). Available: ${sample.join(", ")}${
          models.length > sample.length ? `, … (${models.length - sample.length} more)` : ""
        }. Fix: pick one of these in the policy, or run \`merge-safely connections test ${conn.id}\` to refresh.`,
      );
    }
    name = loose.name;
    if (sel.effort && loose.effortLevels && !loose.effortLevels.includes(sel.effort)) {
      opts.onWarning?.(
        `model ${loose.name} on ${conn.id} does not list effort "${sel.effort}" (supports: ${loose.effortLevels.join(", ")})`,
      );
    }
  }
  return { connectionId: conn.id, provider: conn.provider, name, ...(sel.effort ? { effort: sel.effort } : {}) };
}

/** Metadata only: the secret is dropped. Safe to log. */
export function redactConnection(conn: Connection | ConnectionRecord): ConnectionRecord {
  const { id, provider, kind, label, createdBy, createdAt, lastValidatedAt, scopes, defaultModel, options } = conn;
  return {
    id,
    provider,
    kind,
    createdAt,
    ...(label !== undefined ? { label } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    ...(lastValidatedAt !== undefined ? { lastValidatedAt } : {}),
    ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(options !== undefined ? { options: { ...options } } : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (_err: unknown) {
    return "invalid-url";
  }
}

/** One-line, log-safe description: `anthropic-main (anthropic, api-key, key …k3Fd)`. */
export function describeConnection(conn: Connection | ConnectionRecord): string {
  const parts: string[] = [String(conn.provider), conn.kind];
  const secret = "secret" in conn ? conn.secret : undefined;
  if (secret) {
    switch (secret.kind) {
      case "api-key":
        parts.push(`key ${maskSecret(secret.apiKey)}`);
        break;
      case "openai-compatible":
      case "anthropic-compatible":
        parts.push(hostOf(secret.baseUrl));
        parts.push(secret.apiKey ? `key ${maskSecret(secret.apiKey)}` : "no key");
        break;
      case "oauth":
        parts.push(`token ${maskSecret(secret.accessToken)}`);
        if (secret.expiresAt) parts.push(`expires ${secret.expiresAt}`);
        break;
      case "cloud":
        if (secret.region) parts.push(secret.region);
        if (secret.projectOrResource) parts.push(secret.projectOrResource);
        break;
      case "subscription":
        parts.push(secret.credentialFileRef ? "credential file" : "default login");
        break;
    }
  }
  if (conn.defaultModel) parts.push(`default ${conn.defaultModel}`);
  return `${conn.id} (${parts.join(", ")})`;
}
