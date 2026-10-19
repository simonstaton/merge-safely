import type {
  CostEntry,
  CostLedger,
  RepoRef,
  SpendSummary,
  Verdict,
  VerdictKey,
  VerdictStore,
} from "@merge-safely/core";
import Database from "better-sqlite3";
import { compareVerdicts, normaliseRepo, repoKeyString, verdictKeyString } from "./key.js";
import { combine, entryAtMs, type Totals, toSummary, usdToMicros, validateEntry, zeroTotals } from "./money.js";
import { migrate } from "./schema.js";

export interface SqliteStoresOptions {
  /** Database file. Local disk only: WAL does not work over network filesystems. */
  path: string;
  now?: () => Date;
}

export interface SqliteStores {
  verdicts: VerdictStore;
  ledger: CostLedger;
  close(): void;
  /**
   * Fold cost entries older than `olderThanMs` (default 30 days) into per-change rollups, delete them,
   * then truncate the WAL. Totals are unchanged by construction.
   */
  compact(opts?: { olderThanMs?: number; force?: boolean }): { compacted: number };
}

export const DEFAULT_COMPACT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest rolling window the design allows. Compacting younger rows would make window sums over-count. */
export const MIN_COMPACT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

interface TotalsRow {
  usd: number;
  tin: number;
  tout: number;
  tcin: number;
  tcw: number;
  n: number;
}

const SUM_COLS = `COALESCE(SUM(usd_micros), 0) AS usd, COALESCE(SUM(tokens_in), 0) AS tin,
  COALESCE(SUM(tokens_out), 0) AS tout, COALESCE(SUM(tokens_cached_in), 0) AS tcin,
  COALESCE(SUM(tokens_cache_write), 0) AS tcw`;

function rowTotals(r: TotalsRow | undefined): Totals {
  if (!r) return zeroTotals();
  return { usdMicros: r.usd, in: r.tin, out: r.tout, cachedIn: r.tcin, cacheWrite: r.tcw, entries: r.n };
}

/** Only a primary-key clash means "lost the create race"; any other constraint error is a real failure. */
function isPrimaryKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

/**
 * SQLite VerdictStore + CostLedger on one database file (WAL, synchronous=NORMAL, busy_timeout=5000).
 * Several processes may open the same file; CAS and appends are transactional.
 */
export function sqliteStores(opts: SqliteStoresOptions): SqliteStores {
  const now = opts.now ?? (() => new Date());
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);

  // ---- verdicts ------------------------------------------------------------

  const selVerdict = db.prepare<[string], { json: string; version: number }>(
    "SELECT json, version FROM verdicts WHERE key = ?",
  );
  const insVerdict = db.prepare<[string, string, string, string, number, string, string, string]>(
    `INSERT INTO verdicts (key, repo_host, repo_owner, repo_name, number, head_sha, version, created_at, json)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const updVerdict = db.prepare<[string, string, string, number], { version: number }>(
    `UPDATE verdicts SET created_at = ?, json = ?, version = version + 1
     WHERE key = ? AND version = ? RETURNING version`,
  );
  const listVerdicts = db.prepare<[string, string, string, number], { json: string }>(
    "SELECT json FROM verdicts WHERE repo_host = ? AND repo_owner = ? AND repo_name = ? AND number = ?",
  );

  const putTx = db.transaction((v: Verdict, expect: string | null): { ok: boolean; version: string } => {
    const key = verdictKeyString(v);
    const createdAt = normaliseIso(v.createdAt);
    const json = JSON.stringify(v);
    const current = () => {
      const row = selVerdict.get(key);
      return row ? String(row.version) : "";
    };
    if (expect === null) {
      try {
        const r = normaliseRepo(v.repo);
        insVerdict.run(key, r.host, r.owner, r.name, v.number, v.headSha.toLowerCase(), createdAt, json);
        return { ok: true, version: "1" };
      } catch (err: unknown) {
        if (isPrimaryKeyViolation(err)) return { ok: false, version: current() };
        throw err;
      }
    }
    if (!/^\d+$/.test(expect)) return { ok: false, version: current() };
    const updated = updVerdict.get(createdAt, json, key, Number(expect));
    return updated ? { ok: true, version: String(updated.version) } : { ok: false, version: current() };
  });

  const verdicts: VerdictStore = {
    async get(key: VerdictKey) {
      const row = selVerdict.get(verdictKeyString(key));
      return row ? { verdict: JSON.parse(row.json) as Verdict, version: String(row.version) } : null;
    },
    async put(v, expect) {
      return putTx.immediate(v, expect.version);
    },
    async listForChange(repo, number) {
      const r = normaliseRepo(repo);
      // Sorted with the shared comparator so ordering (and unparseable createdAt) matches every other store.
      return listVerdicts
        .all(r.host, r.owner, r.name, number)
        .map((row) => JSON.parse(row.json) as Verdict)
        .sort(compareVerdicts);
    },
  };

  // ---- ledger --------------------------------------------------------------

  const insEntry = db.prepare(
    `INSERT INTO cost_entries (at, installation_id, repo_key, number, head_sha, round, seat_id, lens, connection_id,
       provider, model, tokens_in, tokens_out, tokens_cached_in, tokens_cache_write, usd_micros, estimated)
     VALUES (@at, @installation_id, @repo_key, @number, @head_sha, @round, @seat_id, @lens, @connection_id,
       @provider, @model, @tokens_in, @tokens_out, @tokens_cached_in, @tokens_cache_write, @usd_micros, @estimated)`,
  );
  const liveForChange = db.prepare<[string, number], TotalsRow>(
    `SELECT ${SUM_COLS}, COUNT(*) AS n FROM cost_entries WHERE repo_key = ? AND number = ?`,
  );
  const rollForChange = db.prepare<[string, number], TotalsRow>(
    `SELECT ${SUM_COLS}, COALESCE(SUM(entries), 0) AS n FROM cost_rollups WHERE repo_key = ? AND number = ?`,
  );
  const liveForInst = db.prepare<[string], TotalsRow>(
    `SELECT ${SUM_COLS}, COUNT(*) AS n FROM cost_entries WHERE installation_id = ?`,
  );
  const rollForInst = db.prepare<[string], TotalsRow>(
    `SELECT ${SUM_COLS}, COALESCE(SUM(entries), 0) AS n FROM cost_rollups WHERE installation_id = ?`,
  );
  // No upper bound: entries are clamped to append time, and anything ahead of the reading clock counts as now.
  const liveForWindow = db.prepare<[string, number], TotalsRow>(
    `SELECT ${SUM_COLS}, COUNT(*) AS n FROM cost_entries WHERE installation_id = ? AND at > ?`,
  );
  // Rollups lose per-row timestamps. A rollup whose newest row falls inside the window is counted whole:
  // over-counting is the safe direction for a budget ceiling.
  const rollForWindow = db.prepare<[string, number], TotalsRow>(
    `SELECT ${SUM_COLS}, COALESCE(SUM(entries), 0) AS n FROM cost_rollups WHERE installation_id = ? AND through_at > ?`,
  );
  const selReset = db.prepare<[string], TotalsRow>(
    `SELECT baseline_usd_micros AS usd, baseline_tokens_in AS tin, baseline_tokens_out AS tout,
       baseline_tokens_cached_in AS tcin, baseline_tokens_cache_write AS tcw, baseline_entries AS n
     FROM ledger_resets WHERE installation_id = ?`,
  );
  const upsertReset = db.prepare<[string, number, number, number, number, number, number, number]>(
    `INSERT INTO ledger_resets (installation_id, baseline_usd_micros, baseline_tokens_in, baseline_tokens_out,
       baseline_tokens_cached_in, baseline_tokens_cache_write, baseline_entries, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (installation_id) DO UPDATE SET
       baseline_usd_micros = excluded.baseline_usd_micros, baseline_tokens_in = excluded.baseline_tokens_in,
       baseline_tokens_out = excluded.baseline_tokens_out, baseline_tokens_cached_in = excluded.baseline_tokens_cached_in,
       baseline_tokens_cache_write = excluded.baseline_tokens_cache_write, baseline_entries = excluded.baseline_entries,
       at = excluded.at`,
  );
  const foldOld = db.prepare<[number]>(
    `INSERT INTO cost_rollups (installation_id, repo_key, number, usd_micros, tokens_in, tokens_out, tokens_cached_in,
       tokens_cache_write, entries, through_at)
     SELECT installation_id, repo_key, number, SUM(usd_micros), SUM(tokens_in), SUM(tokens_out), SUM(tokens_cached_in),
       SUM(tokens_cache_write), COUNT(*), MAX(at)
     FROM cost_entries WHERE at < ? GROUP BY installation_id, repo_key, number`,
  );
  const deleteOld = db.prepare<[number]>("DELETE FROM cost_entries WHERE at < ?");

  const rawAllTime = (id: string): Totals => combine(rowTotals(liveForInst.get(id)), rowTotals(rollForInst.get(id)));

  const resetTx = db.transaction((id: string) => {
    const t = rawAllTime(id);
    upsertReset.run(id, t.usdMicros, t.in, t.out, t.cachedIn, t.cacheWrite, t.entries, now().getTime());
  });

  const compactTx = db.transaction((cutoff: number): number => {
    foldOld.run(cutoff);
    return deleteOld.run(cutoff).changes;
  });

  const ledger: CostLedger = {
    async append(entry: CostEntry) {
      validateEntry(entry);
      insEntry.run({
        at: entryAtMs(entry.at, now().getTime()),
        installation_id: entry.installationId ?? null,
        repo_key: repoKeyString(entry.repo),
        number: entry.number,
        head_sha: entry.headSha.toLowerCase(),
        round: entry.round,
        seat_id: entry.seatId,
        lens: entry.lens,
        connection_id: entry.connectionId,
        provider: entry.provider,
        model: entry.model,
        tokens_in: entry.tokens.in,
        tokens_out: entry.tokens.out,
        tokens_cached_in: entry.tokens.cachedIn ?? 0,
        tokens_cache_write: entry.tokens.cacheWrite ?? 0,
        usd_micros: usdToMicros(entry.usd),
        estimated: entry.estimated ? 1 : 0,
      });
    },
    async forChange(repo: RepoRef, number: number): Promise<SpendSummary> {
      const k = repoKeyString(repo);
      return toSummary(combine(rowTotals(liveForChange.get(k, number)), rowTotals(rollForChange.get(k, number))));
    },
    async forWindow(installationId: string, windowMs: number): Promise<SpendSummary> {
      const nowMs = now().getTime();
      const start = nowMs - windowMs;
      return toSummary(
        combine(
          rowTotals(liveForWindow.get(installationId, start)),
          rowTotals(rollForWindow.get(installationId, start)),
        ),
      );
    },
    async allTime(installationId: string): Promise<SpendSummary> {
      return toSummary(combine(rawAllTime(installationId), rowTotals(selReset.get(installationId)), -1));
    },
    async reset(installationId: string) {
      resetTx.immediate(installationId);
    },
  };

  return {
    verdicts,
    ledger,
    close() {
      db.close();
    },
    compact(copts) {
      const olderThanMs = copts?.olderThanMs ?? DEFAULT_COMPACT_OLDER_THAN_MS;
      if (olderThanMs < MIN_COMPACT_OLDER_THAN_MS && !copts?.force) {
        throw new Error(
          `compact olderThanMs must be at least ${MIN_COMPACT_OLDER_THAN_MS} (7 days) so window sums stay exact; pass force: true to override`,
        );
      }
      const compacted = compactTx.immediate(now().getTime() - olderThanMs);
      db.pragma("wal_checkpoint(TRUNCATE)");
      return { compacted };
    },
  };
}

/** ISO timestamps normalised to UTC with milliseconds so lexical order equals chronological order. */
function normaliseIso(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString();
}
