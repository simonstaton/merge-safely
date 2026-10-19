import { listEntries, readRawConnections, removeEntry, writeRawConnections } from "../connections-file.js";
import { CliError, EXIT } from "../errors.js";
import { table } from "../io.js";
import type { Runtime } from "../runtime.js";

export async function connectionsList(rt: Runtime): Promise<number> {
  const { file, missing } = await readRawConnections(rt.paths.connections);
  const rows = listEntries(file);
  if (rt.json) {
    rt.printJson({ path: rt.paths.connections, connections: rows });
    return 0;
  }
  if (missing || rows.length === 0) {
    rt.out(`No connections in ${rt.paths.connections}. Add one with: merge-safely connect <provider>`);
    return 0;
  }
  rt.out(
    table(
      ["id", "provider", "kind", "label", "model", "last validated", "secret"],
      rows.map((r) => [
        r.invalid ? `${r.id} (invalid: ${r.invalid})` : r.id,
        r.provider,
        r.kind,
        r.label || "-",
        r.model || "-",
        r.lastValidated || "never",
        r.secret,
      ]),
    ),
  );
  return 0;
}

export async function connectionsPath(rt: Runtime): Promise<number> {
  rt.out(rt.paths.connections);
  return 0;
}

export async function connectionsRemove(rt: Runtime, id: string): Promise<number> {
  const { file } = await readRawConnections(rt.paths.connections);
  if (!removeEntry(file, id)) {
    const known = listEntries(file).map((c) => c.id);
    throw new CliError(
      "CONNECTION_NOT_FOUND",
      `no connection "${id}" in ${rt.paths.connections} (known: ${known.length ? known.join(", ") : "none"})`,
    );
  }
  await writeRawConnections(rt.paths.connections, file);
  if (rt.json) rt.printJson({ removed: id, path: rt.paths.connections });
  else rt.out(`Removed ${id} from ${rt.paths.connections}.`);
  return 0;
}

interface TestRow {
  id: string;
  ok: boolean;
  message?: string;
  models?: number;
  latencyMs?: number;
}

export async function connectionsTest(rt: Runtime, id: string | undefined): Promise<number> {
  const all = await rt.loadConnections();
  const targets = id ? all.filter((c) => c.id === id) : all;
  if (id && targets.length === 0) {
    throw new CliError(
      "CONNECTION_NOT_FOUND",
      `no usable connection "${id}" (known: ${all.map((c) => c.id).join(", ") || "none"})`,
    );
  }
  if (targets.length === 0) {
    throw new CliError("NO_CONNECTIONS", `no connections to test; add one with \`merge-safely connect <provider>\``);
  }
  const registry = rt.ctx.registry();
  const rows: TestRow[] = await Promise.all(
    targets.map(async (conn): Promise<TestRow> => {
      try {
        const v = await registry.forConnection(conn).validate(conn);
        return {
          id: conn.id,
          ok: v.ok,
          ...(v.message ? { message: rt.secrets.scrub(v.message) } : {}),
          ...(v.models ? { models: v.models.length } : {}),
          ...(v.latencyMs !== undefined ? { latencyMs: v.latencyMs } : {}),
        };
      } catch (err: unknown) {
        return { id: conn.id, ok: false, message: rt.secrets.scrub(err instanceof Error ? err.message : String(err)) };
      }
    }),
  );
  const okIds = new Set(rows.filter((r) => r.ok).map((r) => r.id));
  if (okIds.size) {
    const { file, missing } = await readRawConnections(rt.paths.connections);
    if (!missing) {
      const at = rt.ctx.now().toISOString();
      for (const e of file.connections) if (typeof e.id === "string" && okIds.has(e.id)) e.lastValidatedAt = at;
      try {
        await writeRawConnections(rt.paths.connections, file);
      } catch (err: unknown) {
        rt.warn(`could not record lastValidatedAt: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const allOk = rows.every((r) => r.ok);
  if (rt.json) {
    rt.printJson({ ok: allOk, results: rows });
  } else {
    const c = rt.colour;
    for (const r of rows) {
      const detail = [
        r.models !== undefined ? `${r.models} models` : "",
        r.latencyMs !== undefined ? `${r.latencyMs} ms` : "",
        r.message ?? "",
      ]
        .filter(Boolean)
        .join(", ");
      rt.out(`${r.ok ? c.green("ok  ") : c.red("FAIL")}  ${r.id}${detail ? `  ${detail}` : ""}`);
    }
  }
  return allOk ? 0 : EXIT.error;
}
