import type { Connection, ModelInfo } from "@merge-safely/core";
import { scrubText, secretValues } from "./mask.js";
import type { ProviderRegistry } from "./registry.js";

export interface CatalogProblem {
  connectionId: string;
  message: string;
}

export interface Catalog {
  byConnection: Map<string, ModelInfo[]>;
  problems: CatalogProblem[];
}

export interface BuildCatalogOptions {
  /** Call `provider.validate(conn)` first; a failed validation records a problem and yields no models. */
  validate?: boolean;
  /** Connection id -> models. Hits skip the provider call; misses are filled in. */
  cache?: Map<string, ModelInfo[]>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask every connection's provider which models it can reach. Never throws because of one bad
 * connection: the failure is recorded in `problems` (with any secret values masked) and that
 * connection maps to an empty list.
 */
export async function buildCatalog(
  registry: ProviderRegistry,
  connections: Connection[],
  opts: BuildCatalogOptions = {},
): Promise<Catalog> {
  const byConnection = new Map<string, ModelInfo[]>();
  const problems: CatalogProblem[] = [];

  await Promise.all(
    connections.map(async (conn) => {
      const scrub = (m: string) => scrubText(m, secretValues(conn.secret));
      const cached = opts.cache?.get(conn.id);
      if (cached && !opts.validate) {
        byConnection.set(conn.id, cached);
        return;
      }
      let models: ModelInfo[] = [];
      try {
        const provider = registry.forConnection(conn);
        if (opts.validate) {
          const v = await provider.validate(conn);
          if (!v.ok) {
            problems.push({
              connectionId: conn.id,
              message: scrub(`validation failed: ${v.message ?? "unknown error"}`),
            });
            byConnection.set(conn.id, []);
            return;
          }
        }
        models = cached ?? (await provider.models(conn));
        opts.cache?.set(conn.id, models);
      } catch (err: unknown) {
        problems.push({ connectionId: conn.id, message: scrub(errMessage(err)) });
      }
      byConnection.set(conn.id, models);
    }),
  );

  // Keep the connections' order in the map for stable output.
  const ordered = new Map<string, ModelInfo[]>();
  for (const c of connections) ordered.set(c.id, byConnection.get(c.id) ?? []);
  problems.sort(
    (a, b) =>
      connections.findIndex((c) => c.id === a.connectionId) - connections.findIndex((c) => c.id === b.connectionId),
  );
  return { byConnection: ordered, problems };
}

/** Adapter to the `(connectionId) => ModelInfo[]` shape the core panel takes as its injected catalog. */
export function catalogLookup(catalog: Catalog): (connectionId: string) => ModelInfo[] {
  return (connectionId) => catalog.byConnection.get(connectionId) ?? [];
}
