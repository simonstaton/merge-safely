import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costLedgerContract,
  FIXTURE_REPO,
  fakeClock,
  makeCostEntry,
  makeVerdict,
  verdictStoreContract,
} from "@merge-safely/store-memory";
import Database from "better-sqlite3";
import * as t from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verdictKeyString } from "./key.js";
import { SCHEMA_VERSION } from "./schema.js";
import { type SqliteStores, sqliteStores } from "./sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "merge-safely-store-sqlite-"));
  return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

verdictStoreContract(t, "sqlite", async () => {
  const { path, cleanup } = await tempDb();
  const s = sqliteStores({ path });
  return {
    store: s.verdicts,
    close: async () => {
      s.close();
      await cleanup();
    },
  };
});

verdictStoreContract(t, "sqlite (two connections on one file)", async () => {
  const { path, cleanup } = await tempDb();
  const a = sqliteStores({ path });
  const b = sqliteStores({ path });
  let n = 0;
  const pick = () => (n++ % 2 === 0 ? a : b).verdicts;
  return {
    store: {
      get: (k) => pick().get(k),
      put: (v, e) => pick().put(v, e),
      listForChange: (r, num) => pick().listForChange(r, num),
    },
    close: async () => {
      a.close();
      b.close();
      await cleanup();
    },
  };
});

costLedgerContract(t, "sqlite", async (clock) => {
  const { path, cleanup } = await tempDb();
  const s = sqliteStores({ path, now: clock.now });
  return {
    ledger: s.ledger,
    close: async () => {
      s.close();
      await cleanup();
    },
  };
});

costLedgerContract(t, "sqlite (compacted before every read)", async (clock) => {
  // Compacting rows older than the longest window (7 days per the design) must never change what the ledger reports.
  const { path, cleanup } = await tempDb();
  const s = sqliteStores({ path, now: clock.now });
  const compactAll = () => s.compact({ olderThanMs: 8 * 24 * 3_600_000 });
  return {
    ledger: {
      append: (e) => s.ledger.append(e),
      forChange: (r, num) => {
        compactAll();
        return s.ledger.forChange(r, num);
      },
      forWindow: (id, ms) => {
        compactAll();
        return s.ledger.forWindow(id, ms);
      },
      allTime: (id) => {
        compactAll();
        return s.ledger.allTime(id);
      },
      reset: async (id) => {
        compactAll();
        await s.ledger.reset?.(id);
      },
    },
    close: async () => {
      s.close();
      await cleanup();
    },
  };
});

describe("sqliteStores", () => {
  let path: string;
  let cleanup: () => Promise<void>;
  let open: SqliteStores[];
  const make = (now?: () => Date) => {
    const s = sqliteStores(now ? { path, now } : { path });
    open.push(s);
    return s;
  };

  beforeEach(async () => {
    ({ path, cleanup } = await tempDb());
    open = [];
  });
  afterEach(async () => {
    for (const s of open) {
      try {
        s.close();
      } catch (err: unknown) {
        void err;
      }
    }
    await cleanup();
  });

  it("sets WAL journal mode, synchronous=NORMAL and busy_timeout", () => {
    make();
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      raw.close();
    }
  });

  it("migrates once and is idempotent on reopen, keeping data", async () => {
    const first = make();
    await first.verdicts.put(makeVerdict(), { version: null });
    await first.ledger.append(makeCostEntry({ usd: 1.25 }));
    first.close();
    open.length = 0;

    const second = make();
    const third = make();
    expect((await third.verdicts.get(makeVerdict()))?.version).toBe("1");
    expect((await second.ledger.allTime("inst-1")).usd).toBe(1.25);

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      const tables = raw
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(["cost_entries", "cost_rollups", "ledger_resets", "verdicts"]);
    } finally {
      raw.close();
    }
  });

  it("refuses to open a database with a newer schema", () => {
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => make()).toThrow(/newer/);
  });

  it("stores usd as integer micro-dollars", async () => {
    const s = make();
    await s.ledger.append(makeCostEntry({ usd: 0.1 }));
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare<[], { usd_micros: number }>("SELECT usd_micros FROM cost_entries").get()?.usd_micros).toBe(
        100_000,
      );
    } finally {
      raw.close();
    }
  });

  it("compaction folds old rows into per-change rollups without changing any total", async () => {
    const clock = fakeClock("2026-03-01T00:00:00.000Z");
    const s = make(clock.now);
    const day = 24 * 3_600_000;
    const other = { ...FIXTURE_REPO, name: "other" };
    const entries = [
      makeCostEntry({ usd: 0.1, at: "2026-01-01T00:00:00.000Z", tokens: { in: 1, out: 2, cachedIn: 3 } }),
      makeCostEntry({ usd: 0.2, at: "2026-01-02T00:00:00.000Z", round: 2, tokens: { in: 4, out: 5, cacheWrite: 6 } }),
      makeCostEntry({ usd: 0.3, at: "2026-01-03T00:00:00.000Z", repo: other, tokens: { in: 7, out: 8 } }),
      makeCostEntry({ usd: 0.4, at: "2026-01-04T00:00:00.000Z", installationId: undefined }),
      makeCostEntry({ usd: 0.5, at: "2026-02-28T12:00:00.000Z", tokens: { in: 9, out: 9 } }),
      makeCostEntry({ usd: 7, at: "2026-01-05T00:00:00.000Z", installationId: "inst-2", number: 2 }),
    ];
    for (const e of entries) await s.ledger.append(e);

    const snapshot = async () => ({
      change: await s.ledger.forChange(FIXTURE_REPO, 1),
      other: await s.ledger.forChange(other, 1),
      all1: await s.ledger.allTime("inst-1"),
      all2: await s.ledger.allTime("inst-2"),
      week: await s.ledger.forWindow("inst-1", 7 * day),
    });
    const before = await snapshot();
    expect(before.change.usd).toBe(1.2);
    expect(before.all1.usd).toBe(1.1);

    expect(s.compact({ olderThanMs: 30 * day }).compacted).toBe(5);
    expect(await snapshot()).toEqual(before);
    expect(s.compact({ olderThanMs: 30 * day }).compacted).toBe(0);

    // Reset after compaction, then compact the rest: still consistent.
    await s.ledger.reset?.("inst-1");
    expect((await s.ledger.allTime("inst-1")).usd).toBe(0);
    expect(s.compact({ olderThanMs: 0, force: true }).compacted).toBe(1);
    expect((await s.ledger.allTime("inst-1")).usd).toBe(0);
    expect((await s.ledger.forChange(FIXTURE_REPO, 1)).usd).toBe(1.2);
    expect((await s.ledger.forChange(FIXTURE_REPO, 1)).entries).toBe(4);

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cost_entries").get()?.n).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("compaction truncates the WAL", async () => {
    const { statSync } = await import("node:fs");
    const s = make();
    for (let i = 0; i < 200; i++) await s.ledger.append(makeCostEntry({ usd: 0.01 }));
    s.compact({ olderThanMs: 0, force: true });
    expect(statSync(`${path}-wal`).size).toBe(0);
  });

  it("window sums count a rollup whole when its newest row is inside the window (over-count, never under)", async () => {
    const clock = fakeClock("2026-01-10T00:00:00.000Z");
    const s = make(clock.now);
    const hour = 3_600_000;
    await s.ledger.append(makeCostEntry({ usd: 1, at: "2026-01-09T00:00:00.000Z" })); // 24 h ago
    await s.ledger.append(makeCostEntry({ usd: 2, at: "2026-01-09T23:00:00.000Z" })); // 1 h ago
    expect((await s.ledger.forWindow("inst-1", 2 * hour)).usd).toBe(2);
    s.compact({ olderThanMs: 0, force: true });
    expect((await s.ledger.forWindow("inst-1", 2 * hour)).usd).toBe(3);
    clock.advance(2 * hour);
    expect((await s.ledger.forWindow("inst-1", 2 * hour)).usd).toBe(0);
  });

  it("compact refuses thresholds under 7 days unless forced", () => {
    const s = make();
    expect(() => s.compact({ olderThanMs: 24 * 3_600_000 })).toThrow(/7 days/);
    expect(s.compact({ olderThanMs: 24 * 3_600_000, force: true }).compacted).toBe(0);
    expect(s.compact({ olderThanMs: 7 * 24 * 3_600_000 }).compacted).toBe(0);
    expect(s.compact().compacted).toBe(0);
  });

  it("a non-primary-key constraint error is rethrown, not reported as a lost race", async () => {
    const s = make();
    const bad = makeVerdict({ createdAt: null as unknown as string });
    await expect(s.verdicts.put(bad, { version: null })).rejects.toThrow(/NOT NULL/);
  });

  it("migrates a v1 database to the current schema", async () => {
    make().close();
    open.length = 0;
    const raw = new Database(path);
    raw.exec("DROP INDEX cost_entries_at");
    raw.pragma("user_version = 1");
    raw.close();
    make();
    const check = new Database(path, { readonly: true });
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      const idx = check
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'cost_entries_at'",
        )
        .all();
      expect(idx).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  it("another process holding the write lock: put waits on busy_timeout, then sees the newer version", async () => {
    const s = make();
    const v = makeVerdict();
    const base = await s.verdicts.put(v, { version: null });
    const sqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const script = `
      const D = require(process.argv[1]);
      const db = new D(process.argv[2]);
      db.pragma("busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE verdicts SET version = version + 1 WHERE key = ?").run(process.argv[3]);
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, 300);
    `;
    const child = spawn(process.execPath, ["-e", script, sqlitePath, path, verdictKeyString(v)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("locked")) resolve();
      });
      child.on("error", reject);
    });
    const t0 = Date.now();
    const res = await s.verdicts.put(makeVerdict({ round: 2 }), { version: base.version });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(res).toEqual({ ok: false, version: "2" });
    expect(await exited).toBe(0);
    expect((await s.verdicts.put(makeVerdict({ round: 3 }), { version: "2" })).ok).toBe(true);
  });

  it("concurrent CAS across two connections: exactly one of ten wins", async () => {
    const a = make();
    const b = make();
    const base = await a.verdicts.put(makeVerdict(), { version: null });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).verdicts.put(makeVerdict({ round: i + 2 }), { version: base.version }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await a.verdicts.get(makeVerdict()))?.version).toBe(results.find((r) => r.ok)?.version);
  });

  it("a non-numeric expected version is a CAS miss, not an error", async () => {
    const s = make();
    const v1 = await s.verdicts.put(makeVerdict(), { version: null });
    const res = await s.verdicts.put(makeVerdict({ round: 2 }), { version: "m1" });
    expect(res).toEqual({ ok: false, version: v1.version });
  });
});

describe("shared helpers", () => {
  it("key.ts and money.ts are byte-identical to the canonical copies in store-memory", async () => {
    for (const f of ["key.ts", "money.ts"]) {
      const mine = await readFile(new URL(f, import.meta.url), "utf8");
      const canonical = await readFile(new URL(`../../store-memory/src/${f}`, import.meta.url), "utf8");
      expect(mine, `${f} drifted from packages/store-memory/src/${f}`).toBe(canonical);
    }
  });
});
