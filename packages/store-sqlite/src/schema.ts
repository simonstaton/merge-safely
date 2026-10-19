import type Database from "better-sqlite3";

/** Bump when adding a migration below. Stored in PRAGMA user_version. */
export const SCHEMA_VERSION = 1;

const V1 = `
CREATE TABLE IF NOT EXISTS verdicts (
  key        TEXT PRIMARY KEY,
  repo_host  TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name  TEXT NOT NULL,
  number     INTEGER NOT NULL,
  head_sha   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_change ON verdicts (repo_host, repo_owner, repo_name, number);

CREATE TABLE IF NOT EXISTS cost_entries (
  id                 INTEGER PRIMARY KEY,
  at                 INTEGER NOT NULL, -- epoch ms
  installation_id    TEXT,
  repo_key           TEXT NOT NULL,
  number             INTEGER NOT NULL,
  head_sha           TEXT NOT NULL,
  round              INTEGER NOT NULL,
  seat_id            TEXT NOT NULL,
  lens               TEXT NOT NULL,
  connection_id      TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  tokens_in          INTEGER NOT NULL,
  tokens_out         INTEGER NOT NULL,
  tokens_cached_in   INTEGER NOT NULL,
  tokens_cache_write INTEGER NOT NULL,
  usd_micros         INTEGER NOT NULL,
  estimated          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_entries_installation_at ON cost_entries (installation_id, at);
CREATE INDEX IF NOT EXISTS cost_entries_change ON cost_entries (repo_key, number);

CREATE TABLE IF NOT EXISTS cost_rollups (
  installation_id    TEXT,
  repo_key           TEXT NOT NULL,
  number             INTEGER NOT NULL,
  usd_micros         INTEGER NOT NULL,
  tokens_in          INTEGER NOT NULL,
  tokens_out         INTEGER NOT NULL,
  tokens_cached_in   INTEGER NOT NULL,
  tokens_cache_write INTEGER NOT NULL,
  entries            INTEGER NOT NULL,
  through_at         INTEGER NOT NULL -- epoch ms of the newest folded entry
);
CREATE INDEX IF NOT EXISTS cost_rollups_installation ON cost_rollups (installation_id, through_at);
CREATE INDEX IF NOT EXISTS cost_rollups_change ON cost_rollups (repo_key, number);

CREATE TABLE IF NOT EXISTS ledger_resets (
  installation_id             TEXT PRIMARY KEY,
  baseline_usd_micros         INTEGER NOT NULL,
  baseline_tokens_in          INTEGER NOT NULL,
  baseline_tokens_out         INTEGER NOT NULL,
  baseline_tokens_cached_in   INTEGER NOT NULL,
  baseline_tokens_cache_write INTEGER NOT NULL,
  baseline_entries            INTEGER NOT NULL,
  at                          INTEGER NOT NULL
);
`;

const MIGRATIONS: ReadonlyArray<{ to: number; sql: string }> = [{ to: 1, sql: V1 }];

/** Apply pending migrations in one immediate transaction. Idempotent on reopen; refuses a newer schema. */
export function migrate(db: Database.Database): void {
  db.transaction(() => {
    const current = Number(db.pragma("user_version", { simple: true }));
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`);
    }
    for (const m of MIGRATIONS) {
      if (m.to <= current) continue;
      db.exec(m.sql);
      db.pragma(`user_version = ${m.to}`);
    }
  }).immediate();
}
