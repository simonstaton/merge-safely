import { readConnectionsFile, secretValues } from "@merge-safely/providers";
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
  for (const w of await writeRawConnections(rt.paths.connections, file, { home: rt.paths.home })) rt.warn(w);
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

/** `connections.<id>: message` → id, from the providers' per-entry load errors. */
function errorId(e: string): string | undefined {
  return e.match(/^connections\.([^:]+):/)?.[1];
}

export async function connectionsTest(rt: Runtime, id: string | undefined): Promise<number> {
  const { file } = await readRawConnections(rt.paths.connections);
  const rawIds = listEntries(file).map((c) => c.id);
  if (rawIds.length === 0) {
    throw new CliError(
      "NO_CONNECTIONS",
      `no connections in ${rt.paths.connections}; add one with \`merge-safely connect <provider>\``,
    );
  }
  if (id && !rawIds.includes(id)) {
    throw new CliError("CONNECTION_NOT_FOUND", `no connection "${id}" (known: ${rawIds.join(", ")})`);
  }
  const r = await readConnectionsFile(rt.paths.connections, rt.ctx.env, { now: rt.ctx.now });
  for (const w of r.warnings) rt.warn(w);
  for (const c of r.connections) rt.secrets.add(...secretValues(c.secret));
  // Entries that do not load (unset env var, missing master key, …) are failures, never silently skipped.
  const loadFailures: TestRow[] = [];
  for (const e of r.errors) {
    const eid = errorId(e) ?? "?";
    if (id && eid !== id) continue;
    const prev = loadFailures.find((x) => x.id === eid);
    const msg = rt.secrets.scrub(e.replace(/^connections\.[^:]+:\s*/, ""));
    if (prev) prev.message = `${prev.message}; ${msg}`;
    else loadFailures.push({ id: eid, ok: false, message: `could not load: ${msg}` });
  }
  const targets = r.connections.filter((c) => !id || c.id === id);
  const registry = rt.ctx.registry();
  const tested: TestRow[] = await Promise.all(
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
  const order = (x: TestRow) => rawIds.indexOf(x.id);
  const rows = [...tested, ...loadFailures].sort((a, b) => order(a) - order(b));
  const okIds = new Set(rows.filter((x) => x.ok).map((x) => x.id));
  if (okIds.size) {
    const at = rt.ctx.now().toISOString();
    for (const e of file.connections) if (typeof e.id === "string" && okIds.has(e.id)) e.lastValidatedAt = at;
    try {
      await writeRawConnections(rt.paths.connections, file, { home: rt.paths.home });
    } catch (err: unknown) {
      rt.warn(`could not record lastValidatedAt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const allOk = rows.length > 0 && rows.every((x) => x.ok);
  if (rt.json) {
    rt.printJson({ ok: allOk, results: rows });
  } else {
    const c = rt.colour;
    for (const x of rows) {
      const detail = [
        x.models !== undefined ? `${x.models} models` : "",
        x.latencyMs !== undefined ? `${x.latencyMs} ms` : "",
        x.message ?? "",
      ]
        .filter(Boolean)
        .join(", ");
      rt.out(`${x.ok ? c.green("ok  ") : c.red("FAIL")}  ${x.id}${detail ? `  ${detail}` : ""}`);
    }
  }
  return allOk ? 0 : EXIT.error;
}
