/**
 * Per-installation model catalog cache (10 minutes). Building a catalog calls every connection's models endpoint,
 * which is too slow and too chatty to repeat for every job. Saving or removing a connection invalidates it.
 */
import type { Connection } from "@merge-safely/core";
import { buildCatalog, type Catalog, type ProviderRegistry } from "@merge-safely/providers";

export const CATALOG_TTL_MS = 10 * 60 * 1000;

interface Entry {
  at: number;
  /** Connection ids + createdAt the catalog was built from; a change rebuilds it. */
  fingerprint: string;
  catalog: Catalog;
}

const fingerprint = (connections: Connection[]) =>
  connections.map((c) => `${c.id}@${c.createdAt}@${c.lastValidatedAt ?? ""}`).join(",");

export class CatalogCache {
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly ttlMs = CATALOG_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(installationId: number, connections: Connection[]): Promise<Catalog> {
    const fp = fingerprint(connections);
    const hit = this.entries.get(installationId);
    if (hit && hit.fingerprint === fp && this.now() - hit.at < this.ttlMs) return hit.catalog;
    const catalog = await buildCatalog(this.registry, connections);
    this.entries.set(installationId, { at: this.now(), fingerprint: fp, catalog });
    return catalog;
  }

  /** The cached catalog if one exists (any age), without building one. */
  peek(installationId: number): Catalog | undefined {
    return this.entries.get(installationId)?.catalog;
  }

  invalidate(installationId: number): void {
    this.entries.delete(installationId);
  }
}
