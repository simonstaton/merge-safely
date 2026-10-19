import type { Connection, ConnectionRecord, ModelProvider, ProviderId } from "@merge-safely/core";

/** Holds the provider adapters an installation can use, keyed by provider id. */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ModelProvider>();

  /** Register a provider. Re-registering the same id replaces the earlier adapter. */
  register(p: ModelProvider): this {
    if (!p.id) throw new Error("provider must have a non-empty id");
    this.providers.set(p.id, p);
    return this;
  }

  get(id: ProviderId): ModelProvider | undefined {
    return this.providers.get(id);
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * The provider for a connection. Looks up `conn.provider`; when nothing is registered under it and the
   * connection is a compatible kind, falls back to the adapter registered under the kind id
   * (`openai-compatible` / `anthropic-compatible`). Throws when neither exists or the kind is not accepted.
   */
  forConnection(conn: Connection | ConnectionRecord): ModelProvider {
    let p = this.providers.get(conn.provider);
    if (!p && (conn.kind === "openai-compatible" || conn.kind === "anthropic-compatible")) {
      p = this.providers.get(conn.kind);
    }
    if (!p) {
      const known = this.ids();
      const fallback =
        conn.kind === "openai-compatible" || conn.kind === "anthropic-compatible" ? ` or "${conn.kind}"` : "";
      throw new Error(
        `no provider registered for "${conn.provider}"${fallback} (connection ${conn.id}); registered: ${
          known.length ? known.join(", ") : "none"
        }`,
      );
    }
    if (!p.connectionKinds.includes(conn.kind)) {
      throw new Error(
        `provider "${p.id}" does not accept connection kind "${conn.kind}" (connection ${conn.id}); it accepts: ${p.connectionKinds.join(", ")}`,
      );
    }
    return p;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  ids(): ProviderId[] {
    return [...this.providers.keys()];
  }
}

export function createProviderRegistry(providers: ModelProvider[] = []): ProviderRegistry {
  const r = new ProviderRegistry();
  for (const p of providers) r.register(p);
  return r;
}
