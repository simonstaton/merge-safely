/**
 * The App's own persistence on better-sqlite3: installations, encrypted connections, settings, the durable job
 * queue and webhook delivery ids.
 *
 * The same database file also holds the verdict store and cost ledger (`@merge-safely/store-sqlite`, opened on its
 * own connection; its tables are `verdicts`, `cost_*` and `ledger_resets`, so names never clash). One file means one
 * thing to back up and one WAL. Migrations here are idempotent (`CREATE ... IF NOT EXISTS` plus additive,
 * version-gated `ALTER`s).
 */
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Connection, ConnectionRecord, ConnectionSecret } from "@merge-safely/core";
import {
  connectionRecordSchema,
  decryptSecret,
  describeConnection,
  encryptSecret,
  redactConnection,
} from "@merge-safely/providers";
import Database from "better-sqlite3";

export const APP_SCHEMA_VERSION = 1;

export type JobState = "queued" | "running" | "done" | "failed" | "superseded";

export interface JobRow {
  id: number;
  installation_id: number;
  repo: string;
  number: number;
  head_sha: string;
  event: string;
  state: JobState;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  run_after: string;
  superseded_by: number | null;
  base_ref: string | null;
  policy_hash: string | null;
  /** "file" (read from the base ref) or "default" (no policy file on the base ref). */
  policy_source: string | null;
  /** Why the review runs, passed to the gate (e.g. "base-changed" for a retarget). */
  trigger: string | null;
  outcome: string | null;
}

export interface EnqueueInput {
  installationId: number;
  /** "owner/name" */
  repo: string;
  number: number;
  /** Empty string when the event carried no head sha (review the current head). */
  headSha: string;
  event: string;
  /** Base branch named by the event, when it carries one. Jobs only coalesce when the base matches. */
  baseRef?: string;
  /** "base-changed": the PR was retargeted. Never coalesces; supersedes every open job for the PR. */
  reason?: "base-changed";
}

export interface EnqueueResult {
  id: number;
  /** An identical queued/running job already existed; nothing new was queued. */
  coalesced: boolean;
  /** Queued jobs for older SHAs of this PR that this one replaced. */
  supersededQueued: number[];
  /** Running jobs for older SHAs that will be marked superseded when they finish. */
  supersededRunning: number[];
}

export interface StoredConnection {
  record: ConnectionRecord;
  /** Log-safe description with the masked secret tail, captured at save time. */
  hint: string;
}

export interface InstallationRow {
  id: number;
  account: string;
  created_at: string;
  deleted_at: string | null;
}

export const connectionAad = (installationId: number | string, connectionId: string): string =>
  `${installationId}:${connectionId}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS connections (
  installation_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  secret_blob TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (installation_id, id)
);
CREATE TABLE IF NOT EXISTS settings (
  installation_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  run_after TEXT NOT NULL,
  superseded_by INTEGER,
  base_ref TEXT,
  policy_hash TEXT,
  policy_source TEXT,
  trigger TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS jobs_state_run_after ON jobs (state, run_after);
CREATE INDEX IF NOT EXISTS jobs_change ON jobs (installation_id, repo, number, state);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_received ON deliveries (received_at);
`;

/** Max attempts for a job that keeps killing the process (counted at claim and again when found running at boot). */
export const CRASH_MAX_ATTEMPTS = 3;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };

/** 64 hex chars or `base64:` keys are used as-is by encryptSecret; anything else is a passphrase. */
export function isRawMasterKey(key: string): boolean {
  const s = key.trim();
  return /^[0-9a-fA-F]{64}$/.test(s) || s.startsWith("base64:");
}

/**
 * Resolve the master key once: raw keys pass through; a passphrase is stretched with scrypt ONCE (salt stored in
 * app_meta, random per deployment) into a raw 32-byte key, so no request pays for scrypt per connection.
 */
export function deriveMasterKey(key: string, salt: Buffer): string | Buffer {
  if (isRawMasterKey(key)) return key.trim();
  const s = key.trim();
  if (s.length < 12)
    throw new Error("master key must be 64 hex characters, base64:<32 bytes>, or a passphrase of 12+ characters");
  return scryptSync(s, salt, 32, { ...SCRYPT, maxmem: 128 * SCRYPT.N * SCRYPT.r + 2 * 1024 * 1024 });
}

export interface InterruptedResult {
  requeued: number;
  superseded: number;
  /** Jobs that crashed the process too often; the caller reports them on the check run. */
  failed: JobRow[];
}

export interface RotateResult {
  rotated: number;
  alreadyCurrent: number;
  failed: { installationId: number; id: string }[];
}

export interface AppDbOptions {
  path: string;
  masterKey: string;
  now?: () => Date;
}

export class AppDb {
  readonly db: Database.Database;
  private readonly masterKey: string | Buffer;
  private readonly now: () => Date;

  constructor(opts: AppDbOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.now = opts.now ?? (() => new Date());
    this.migrate();
    this.masterKey = this.resolveKey(opts.masterKey);
  }

  private kdfSalt(): Buffer {
    const existing = this.db.prepare<[], { value: string }>("SELECT value FROM app_meta WHERE key = 'kdf_salt'").get();
    if (existing) return Buffer.from(existing.value, "base64");
    const salt = randomBytes(16);
    this.db
      .prepare("INSERT INTO app_meta (key, value) VALUES ('kdf_salt', ?) ON CONFLICT(key) DO NOTHING")
      .run(salt.toString("base64"));
    return this.kdfSalt();
  }

  /** The key material encryptSecret/decryptSecret get for a configured master key (derived once). */
  resolveKey(masterKey: string): string | Buffer {
    return deriveMasterKey(masterKey, this.kdfSalt());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  migrate(): void {
    this.db.exec(SCHEMA);
    // Additive column migrations for databases created by an earlier build.
    const cols = new Set(
      this.db
        .prepare<[], { name: string }>("PRAGMA table_info(jobs)")
        .all()
        .map((c) => c.name),
    );
    for (const c of ["policy_source", "trigger"]) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${c} TEXT`);
    }
    this.db
      .prepare("INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
      .run(String(APP_SCHEMA_VERSION));
  }

  schemaVersion(): number {
    const r = this.db.prepare<[], { value: string }>("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
    return r ? Number(r.value) : 0;
  }

  close(): void {
    this.db.close();
  }

  // ---- installations -------------------------------------------------------

  /** Known and not uninstalled. */
  isActiveInstallation(id: number): boolean {
    const r = this.getInstallation(id);
    return r !== undefined && r.deleted_at === null;
  }

  /** Insert an installation we have never seen; never resurrects one that was uninstalled. */
  addInstallationIfUnknown(id: number, account: string): boolean {
    return (
      this.db
        .prepare("INSERT INTO installations (id, account, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(id, account, this.iso()).changes > 0
    );
  }

  upsertInstallation(id: number, account: string): void {
    this.db
      .prepare(
        `INSERT INTO installations (id, account, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account = excluded.account, deleted_at = NULL`,
      )
      .run(id, account, this.iso());
  }

  /** Uninstall: mark deleted and purge its stored secrets and settings. Repo mirrors are removed by the caller. */
  deleteInstallation(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE installations SET deleted_at = ? WHERE id = ?").run(this.iso(), id);
      this.db.prepare("DELETE FROM connections WHERE installation_id = ?").run(id);
      this.db.prepare("DELETE FROM settings WHERE installation_id = ?").run(id);
      this.db
        .prepare(
          "UPDATE jobs SET state = 'failed', error = 'installation removed', finished_at = ? WHERE installation_id = ? AND state = 'queued'",
        )
        .run(this.iso(), id);
    });
    tx();
  }

  getInstallation(id: number): InstallationRow | undefined {
    return this.db.prepare<[number], InstallationRow>("SELECT * FROM installations WHERE id = ?").get(id);
  }

  listInstallations(): InstallationRow[] {
    return this.db
      .prepare<[], InstallationRow>("SELECT * FROM installations WHERE deleted_at IS NULL ORDER BY id")
      .all();
  }

  // ---- connections ---------------------------------------------------------

  saveConnection(installationId: number, conn: Connection): void {
    const record = connectionRecordSchema.parse(redactConnection(conn));
    const blob = encryptSecret(conn.secret, this.masterKey, connectionAad(installationId, conn.id));
    this.db
      .prepare(
        `INSERT INTO connections (installation_id, id, record_json, secret_blob, hint) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, id) DO UPDATE SET record_json = excluded.record_json,
           secret_blob = excluded.secret_blob, hint = excluded.hint`,
      )
      .run(installationId, conn.id, JSON.stringify(record), blob, describeConnection(conn));
  }

  deleteConnection(installationId: number, id: string): boolean {
    return (
      this.db.prepare("DELETE FROM connections WHERE installation_id = ? AND id = ?").run(installationId, id).changes >
      0
    );
  }

  /** Metadata only: secrets are never decrypted for listing. */
  listConnections(installationId: number): StoredConnection[] {
    const rows = this.db
      .prepare<[number], { record_json: string; hint: string }>(
        "SELECT record_json, hint FROM connections WHERE installation_id = ? ORDER BY id",
      )
      .all(installationId);
    const out: StoredConnection[] = [];
    for (const r of rows) {
      const parsed = connectionRecordSchema.safeParse(JSON.parse(r.record_json));
      if (parsed.success) out.push({ record: parsed.data, hint: r.hint });
    }
    return out;
  }

  /** Decrypt every connection of an installation. Rows that fail to decrypt are reported, never thrown. */
  loadConnections(installationId: number): { connections: Connection[]; problems: { id: string; message: string }[] } {
    const rows = this.db
      .prepare<[number], { id: string; record_json: string; secret_blob: string }>(
        "SELECT id, record_json, secret_blob FROM connections WHERE installation_id = ? ORDER BY id",
      )
      .all(installationId);
    const connections: Connection[] = [];
    const problems: { id: string; message: string }[] = [];
    for (const r of rows) {
      try {
        const record = connectionRecordSchema.parse(JSON.parse(r.record_json));
        const secret = decryptSecret(r.secret_blob, this.masterKey, connectionAad(installationId, r.id));
        connections.push({ ...record, secret });
      } catch (err: unknown) {
        const name = err instanceof Error ? err.name : "Error";
        problems.push({ id: r.id, message: `stored connection could not be opened (${name}); re-connect it` });
      }
    }
    return { connections, problems };
  }

  /**
   * Re-encrypt every stored connection from `oldKey` to this database's current master key. Each row is its own
   * atomic UPDATE, so an interrupted rotation can be re-run: rows already under the new key are skipped.
   */
  rotateMasterKey(oldKey: string): RotateResult {
    const old = this.resolveKey(oldKey);
    const rows = this.db
      .prepare<[], { installation_id: number; id: string; secret_blob: string }>(
        "SELECT installation_id, id, secret_blob FROM connections ORDER BY installation_id, id",
      )
      .all();
    const out: RotateResult = { rotated: 0, alreadyCurrent: 0, failed: [] };
    const update = this.db.prepare(
      "UPDATE connections SET secret_blob = ? WHERE installation_id = ? AND id = ? AND secret_blob = ?",
    );
    for (const r of rows) {
      const aad = connectionAad(r.installation_id, r.id);
      let secret: ConnectionSecret;
      try {
        secret = decryptSecret(r.secret_blob, old, aad);
      } catch (_err: unknown) {
        try {
          decryptSecret(r.secret_blob, this.masterKey, aad);
          out.alreadyCurrent++;
        } catch (_err2: unknown) {
          out.failed.push({ installationId: r.installation_id, id: r.id });
        }
        continue;
      }
      const blob = encryptSecret(secret, this.masterKey, aad);
      if (update.run(blob, r.installation_id, r.id, r.secret_blob).changes > 0) out.rotated++;
      else out.failed.push({ installationId: r.installation_id, id: r.id });
    }
    return out;
  }

  // ---- settings ------------------------------------------------------------

  getSetting(installationId: number, key: string): { found: boolean; value: unknown; raw?: string } {
    const r = this.db
      .prepare<[number, string], { value_json: string }>(
        "SELECT value_json FROM settings WHERE installation_id = ? AND key = ?",
      )
      .get(installationId, key);
    if (!r) return { found: false, value: undefined };
    try {
      return { found: true, value: JSON.parse(r.value_json), raw: r.value_json };
    } catch (_err: unknown) {
      return { found: true, value: undefined, raw: r.value_json };
    }
  }

  setSetting(installationId: number, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (installation_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(installation_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(installationId, key, JSON.stringify(value === undefined ? null : value), this.iso());
  }

  /** Write a raw value (tests use it to simulate a corrupted row). */
  setSettingRaw(installationId: number, key: string, raw: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (installation_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(installation_id, key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(installationId, key, raw, this.iso());
  }

  // ---- deliveries ----------------------------------------------------------

  /** Record a delivery id. Returns false when it was already seen (a redelivery). */
  recordDelivery(deliveryId: string): boolean {
    return (
      this.db
        .prepare("INSERT INTO deliveries (delivery_id, received_at) VALUES (?, ?) ON CONFLICT(delivery_id) DO NOTHING")
        .run(deliveryId, this.iso()).changes > 0
    );
  }

  forgetDelivery(deliveryId: string): void {
    this.db.prepare("DELETE FROM deliveries WHERE delivery_id = ?").run(deliveryId);
  }

  pruneDeliveries(olderThanMs: number): number {
    const cutoff = new Date(this.now().getTime() - olderThanMs).toISOString();
    return this.db.prepare("DELETE FROM deliveries WHERE received_at < ?").run(cutoff).changes;
  }

  // ---- jobs ----------------------------------------------------------------

  /**
   * Enqueue with coalescing, keyed (installation, repo, number, head_sha, base_ref):
   * - an identical queued or running job absorbs the new one, unless the base differs or this is a retarget
   *   (`reason: "base-changed"`): a retarget never coalesces, because the open job read policy from the old base;
   * - queued jobs for other SHAs of the same PR are marked superseded now;
   * - running jobs for other SHAs get `superseded_by` and are marked superseded when they finish.
   */
  enqueue(input: EnqueueInput): EnqueueResult {
    const tx = this.db.transaction((): EnqueueResult => {
      const open = this.db
        .prepare<[number, string, number], JobRow>(
          "SELECT * FROM jobs WHERE installation_id = ? AND repo = ? AND number = ? AND state IN ('queued', 'running')",
        )
        .all(input.installationId, input.repo, input.number);
      const same =
        input.reason === undefined
          ? open.find(
              (j) =>
                j.head_sha === input.headSha &&
                j.superseded_by === null &&
                (input.baseRef === undefined || j.base_ref === null || j.base_ref === input.baseRef),
            )
          : undefined;
      if (same) return { id: same.id, coalesced: true, supersededQueued: [], supersededRunning: [] };
      const now = this.iso();
      const res = this.db
        .prepare(
          `INSERT INTO jobs (installation_id, repo, number, head_sha, event, state, attempts, created_at, run_after,
             base_ref, trigger)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
        )
        .run(
          input.installationId,
          input.repo,
          input.number,
          input.headSha,
          input.event,
          now,
          now,
          input.baseRef ?? null,
          input.reason ?? null,
        );
      const id = Number(res.lastInsertRowid);
      const supersededQueued: number[] = [];
      const supersededRunning: number[] = [];
      for (const j of open) {
        if (j.state === "queued") {
          this.db
            .prepare("UPDATE jobs SET state = 'superseded', superseded_by = ?, finished_at = ?, error = ? WHERE id = ?")
            .run(id, now, `superseded by job ${id}`, j.id);
          supersededQueued.push(j.id);
        } else {
          this.db.prepare("UPDATE jobs SET superseded_by = ? WHERE id = ?").run(id, j.id);
          supersededRunning.push(j.id);
        }
      }
      return { id, coalesced: false, supersededQueued, supersededRunning };
    });
    return tx.immediate();
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare<[number], JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
  }

  /**
   * Claim the oldest runnable job, skipping PRs that already have a running job (one review per PR at a time).
   * Runs as an IMMEDIATE transaction, so it is atomic even with a second process on the file (one replica is the
   * supported deployment).
   */
  claimNext(): JobRow | undefined {
    const tx = this.db.transaction((): JobRow | undefined => {
      const now = this.iso();
      const job = this.db
        .prepare<[string], JobRow>(
          `SELECT * FROM jobs j WHERE j.state = 'queued' AND j.run_after <= ?
             AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.state = 'running' AND r.installation_id = j.installation_id
                             AND r.repo = j.repo AND r.number = j.number)
           ORDER BY j.run_after, j.id LIMIT 1`,
        )
        .get(now);
      if (!job) return undefined;
      this.db
        .prepare("UPDATE jobs SET state = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?")
        .run(now, job.id);
      return this.getJob(job.id);
    });
    return tx.immediate();
  }

  /** Record what the pipeline learned about the job (base ref the policy came from, policy hash). */
  annotateJob(id: number, fields: { baseRef?: string; policyHash?: string; policySource?: string }): void {
    if (fields.baseRef !== undefined) {
      this.db.prepare("UPDATE jobs SET base_ref = ? WHERE id = ?").run(fields.baseRef, id);
    }
    if (fields.policyHash !== undefined) {
      this.db.prepare("UPDATE jobs SET policy_hash = ? WHERE id = ?").run(fields.policyHash, id);
    }
    if (fields.policySource !== undefined) {
      this.db.prepare("UPDATE jobs SET policy_source = ? WHERE id = ?").run(fields.policySource, id);
    }
  }

  /** Queued jobs for a PR end `superseded` (PR closed or merged). Running ones finish and are marked superseded. */
  cancelForChange(installationId: number, repo: string, number: number, reason: string): number {
    const now = this.iso();
    const tx = this.db.transaction(() => {
      const n = this.db
        .prepare(
          `UPDATE jobs SET state = 'superseded', finished_at = ?, error = ?
           WHERE installation_id = ? AND repo = ? AND number = ? AND state = 'queued'`,
        )
        .run(now, reason, installationId, repo, number).changes;
      this.db
        .prepare(
          `UPDATE jobs SET superseded_by = 0 WHERE installation_id = ? AND repo = ? AND number = ?
           AND state = 'running' AND superseded_by IS NULL`,
        )
        .run(installationId, repo, number);
      return n;
    });
    return tx.immediate();
  }

  /** Fail queued jobs of an installation (suspended / uninstalled), optionally only for some repos. */
  failQueued(installationId: number, reason: string, repos?: string[]): number {
    const now = this.iso();
    if (repos === undefined) {
      return this.db
        .prepare(
          "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE installation_id = ? AND state = 'queued'",
        )
        .run(now, reason, installationId).changes;
    }
    const stmt = this.db.prepare(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE installation_id = ? AND repo = ? AND state = 'queued'",
    );
    return repos.reduce((n, r) => n + stmt.run(now, reason, installationId, r).changes, 0);
  }

  /** Finish a job. A running job that a newer SHA superseded ends `superseded` whatever its own outcome. */
  finishJob(id: number, state: "done" | "failed", info: { outcome?: string; error?: string } = {}): JobState {
    const job = this.getJob(id);
    const final: JobState = job?.superseded_by != null ? "superseded" : state;
    this.db
      .prepare("UPDATE jobs SET state = ?, finished_at = ?, outcome = ?, error = ? WHERE id = ?")
      .run(final, this.iso(), info.outcome ?? null, info.error ?? null, id);
    return final;
  }

  supersedeJob(id: number, error: string): void {
    this.db
      .prepare("UPDATE jobs SET state = 'superseded', finished_at = ?, error = ? WHERE id = ?")
      .run(this.iso(), error, id);
  }

  /** Put a failed attempt back in the queue after `delayMs`. */
  retryJob(id: number, delayMs: number, error: string): void {
    const runAfter = new Date(this.now().getTime() + delayMs).toISOString();
    this.db
      .prepare("UPDATE jobs SET state = 'queued', run_after = ?, error = ?, started_at = NULL WHERE id = ?")
      .run(runAfter, error, id);
  }

  /**
   * Boot recovery for jobs left `running` by a crash or a shutdown past its deadline:
   * - superseded ones (a newer SHA or a retarget arrived) end `superseded`, never re-reviewed;
   * - the rest get attempts + 1 (the interrupted run) and go back to the queue while attempts < maxAttempts;
   * - beyond that they end `failed` ("crashed repeatedly") so a poison job cannot crash-loop the service.
   */
  requeueInterrupted(maxAttempts = CRASH_MAX_ATTEMPTS): InterruptedResult {
    const tx = this.db.transaction((): InterruptedResult => {
      const now = this.iso();
      const superseded = this.db
        .prepare(
          `UPDATE jobs SET state = 'superseded', finished_at = ?, error = COALESCE(error, 'superseded while interrupted')
           WHERE state = 'running' AND superseded_by IS NOT NULL`,
        )
        .run(now).changes;
      this.db.prepare("UPDATE jobs SET attempts = attempts + 1 WHERE state = 'running'").run();
      const failed = this.db
        .prepare<[number], JobRow>("SELECT * FROM jobs WHERE state = 'running' AND attempts >= ?")
        .all(maxAttempts);
      for (const j of failed) {
        this.db
          .prepare("UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?")
          .run(now, `crashed repeatedly (${j.attempts} attempts); not retried`, j.id);
      }
      const requeued = this.db
        .prepare("UPDATE jobs SET state = 'queued', started_at = NULL, run_after = ? WHERE state = 'running'")
        .run(now).changes;
      return { requeued, superseded, failed: failed.map((j) => ({ ...j, state: "failed" as const })) };
    });
    return tx.immediate();
  }

  countByState(): Record<JobState, number> {
    const out: Record<JobState, number> = { queued: 0, running: 0, done: 0, failed: 0, superseded: 0 };
    const rows = this.db
      .prepare<[], { state: JobState; n: number }>("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state")
      .all();
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  pruneJobs(olderThanMs: number): number {
    const cutoff = new Date(this.now().getTime() - olderThanMs).toISOString();
    return this.db
      .prepare("DELETE FROM jobs WHERE state IN ('done', 'failed', 'superseded') AND finished_at < ?")
      .run(cutoff).changes;
  }
}
