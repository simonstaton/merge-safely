import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  costLedgerContract,
  FIXTURE_REPO,
  makeCostEntry,
  makeVerdict,
  verdictStoreContract,
} from "@merge-safely/store-memory";
import * as t from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLock, atomicCreate, DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, encodeSegment } from "./io.js";
import { fsCostLedger } from "./ledger.js";
import { fsVerdictStore } from "./verdicts.js";

async function tempDir(): Promise<{ dir: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "merge-safely-store-fs-"));
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}

verdictStoreContract(t, "fs", async () => {
  const { dir, close } = await tempDir();
  return { store: fsVerdictStore(dir), close };
});

verdictStoreContract(t, "fs (two instances on one dir)", async () => {
  // Alternating calls between two instances simulates two processes: they share no in-memory state.
  const { dir, close } = await tempDir();
  const a = fsVerdictStore(dir);
  const b = fsVerdictStore(dir);
  let n = 0;
  const pick = () => (n++ % 2 === 0 ? a : b);
  return {
    store: {
      get: (k) => pick().get(k),
      put: (v, e) => pick().put(v, e),
      listForChange: (r, num) => pick().listForChange(r, num),
    },
    close,
  };
});

costLedgerContract(t, "fs", async (clock) => {
  const { dir, close } = await tempDir();
  return { ledger: fsCostLedger(dir, { now: clock.now }), close };
});

describe("fsVerdictStore", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, close } = await tempDir());
  });
  afterEach(async () => {
    await close();
  });

  it("writes one JSON file per verdict at the documented path and cleans up locks and temp files", async () => {
    const store = fsVerdictStore(dir);
    await store.put(makeVerdict({ headSha: "ABC123" }), { version: null });
    const changeDir = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1");
    expect(await readdir(changeDir)).toEqual(["abc123.json"]);
    const body = JSON.parse(await readFile(join(changeDir, "abc123.json"), "utf8"));
    expect(body.schema).toBe(1);
    expect(body.verdict.headSha).toBe("ABC123");
  });

  it("version is the sha256 of the file contents", async () => {
    const { createHash } = await import("node:crypto");
    const store = fsVerdictStore(dir);
    const res = await store.put(makeVerdict(), { version: null });
    const file = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1", `${"a".repeat(40)}.json`);
    const raw = await readFile(file, "utf8");
    expect(res.version).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("two instances (simulated processes) racing on the same key: exactly one wins", async () => {
    const a = fsVerdictStore(dir);
    const b = fsVerdictStore(dir);
    const base = await a.put(makeVerdict(), { version: null });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? a : b).put(makeVerdict({ round: i + 2 }), { version: base.version }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results.find((r) => r.ok);
    expect((await b.get(makeVerdict()))?.version).toBe(winner?.version);
    expect((await a.get(makeVerdict()))?.version).toBe(winner?.version);
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const store = fsVerdictStore(dir, { lock: { timeoutMs: 2_000 } });
    await store.put(makeVerdict(), { version: null });
    const file = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1", `${"a".repeat(40)}.json`);
    await writeFile(`${file}.lock`, "crashed");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    const cur = await store.get(makeVerdict());
    const res = await store.put(makeVerdict({ round: 2 }), { version: cur?.version ?? null });
    expect(res.ok).toBe(true);
  });

  it("waits on a live lock and times out rather than interleaving", async () => {
    const store = fsVerdictStore(dir, { lock: { timeoutMs: 100 } });
    await store.put(makeVerdict(), { version: null });
    const file = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1", `${"a".repeat(40)}.json`);
    const lock = await acquireFileLock(`${file}.lock`);
    const cur = await store.get(makeVerdict());
    await expect(store.put(makeVerdict({ round: 2 }), { version: cur?.version ?? null })).rejects.toThrow(/timed out/);
    await lock.release();
    expect((await store.put(makeVerdict({ round: 2 }), { version: cur?.version ?? null })).ok).toBe(true);
  });

  it("a corrupt verdict file makes get throw instead of looking missing", async () => {
    const store = fsVerdictStore(dir);
    await store.put(makeVerdict(), { version: null });
    const file = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1", `${"a".repeat(40)}.json`);
    await writeFile(file, "{not json");
    await expect(store.get(makeVerdict())).rejects.toThrow(/corrupt/);
    expect((await store.put(makeVerdict(), { version: null })).ok).toBe(false);
  });

  it("stale-lock stress: many instances breaking one stale lock never yield two winners", async () => {
    const file = join(dir, "verdicts", "github%2Ecom", "acme", "widgets", "1", `${"a".repeat(40)}.json`);
    const stores = Array.from({ length: 8 }, () => fsVerdictStore(dir, { lock: { timeoutMs: 5_000 } }));
    const old = new Date(Date.now() - 60_000);
    const trials = Number(process.env.STORE_FS_STRESS_TRIALS ?? 20);
    for (let trial = 0; trial < trials; trial++) {
      await rm(join(dir, "verdicts"), { recursive: true, force: true });
      await mkdir(dirname(file), { recursive: true });
      // Updates go through the lock alone, so plant a base verdict first on odd trials.
      const base = trial % 2 ? await stores[0]?.put(makeVerdict(), { version: null }) : undefined;
      await writeFile(`${file}.lock`, JSON.stringify({ token: "crashed" }));
      await utimes(`${file}.lock`, old, old);
      const results = await Promise.all(
        stores.map((s, i) => s.put(makeVerdict({ round: i + 2 }), { version: base?.version ?? null })),
      );
      expect(
        results.filter((r) => r.ok),
        `trial ${trial}`,
      ).toHaveLength(1);
      const left = (await readdir(dirname(file))).filter((n) => n !== `${"a".repeat(40)}.json`);
      expect(left, `trial ${trial}`).toEqual([]);
    }
  });

  it("a holder whose lock was taken over refuses to commit", async () => {
    const lockPath = join(dir, "x.lock");
    const lock = await acquireFileLock(lockPath);
    expect(await lock.verify()).toBe(true);
    await writeFile(lockPath, JSON.stringify({ token: "someone-else" }));
    expect(await lock.verify()).toBe(false);
    await lock.release(); // not ours: must not delete it
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe("someone-else");
  });

  it("creates commit atomically and fail when the file already exists", async () => {
    const f = join(dir, "c.txt");
    expect(await atomicCreate(f, "one")).toBe(true);
    expect(await atomicCreate(f, "two")).toBe(false);
    expect(await readFile(f, "utf8")).toBe("one");
    expect(await readdir(dir)).toEqual(["c.txt"]);
  });

  it("default lock timeout outlives the stale threshold", () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LOCK_STALE_MS);
  });

  it("stores under lower-cased path segments and keeps original casing inside", async () => {
    const store = fsVerdictStore(dir);
    await store.put(makeVerdict({ repo: { host: "GitHub.com", owner: "Acme", name: "Widgets" } }), { version: null });
    expect(await readdir(join(dir, "verdicts", "github%2Ecom"))).toEqual(["acme"]);
    expect((await store.get(makeVerdict()))?.verdict.repo.owner).toBe("Acme");
  });

  it("untrusted repo names cannot escape the store directory", async () => {
    const store = fsVerdictStore(dir);
    const repo = { host: "github.com", owner: "..", name: "../../etc" };
    await store.put(makeVerdict({ repo, headSha: "../x" }), { version: null });
    const owners = await readdir(join(dir, "verdicts", "github%2Ecom"));
    expect(owners).toEqual(["%2E%2E"]);
    expect((await store.listForChange(repo, 1)).length).toBe(1);
    expect(encodeSegment("a/b.c")).toBe("a%2Fb%2Ec");
    expect(() => encodeSegment("")).toThrow();
  });
});

describe("fsCostLedger", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, close } = await tempDir());
  });
  afterEach(async () => {
    await close();
  });

  it("appends JSONL per installation with '_' for entries without one", async () => {
    const ledger = fsCostLedger(dir);
    await ledger.append(makeCostEntry({ usd: 1 }));
    await ledger.append(makeCostEntry({ usd: 2, installationId: undefined }));
    expect((await readdir(join(dir, "ledger"))).sort()).toEqual(["_.jsonl", "inst-1.jsonl"]);
    const lines = (await readFile(join(dir, "ledger", "inst-1.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").usdMicros).toBe(1_000_000);
  });

  it("survives a torn trailing line from a crash", async () => {
    const ledger = fsCostLedger(dir);
    await ledger.append(makeCostEntry({ usd: 1 }));
    const file = join(dir, "ledger", "inst-1.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{"at":"2026-01-01`, "utf8");
    await ledger.append(makeCostEntry({ usd: 2 }));
    expect((await ledger.allTime("inst-1")).usd).toBe(3);
    expect((await ledger.allTime("inst-1")).entries).toBe(2);
  });

  it("totals and reset baselines survive a restart (new instance, same dir)", async () => {
    const first = fsCostLedger(dir);
    await first.append(makeCostEntry({ usd: 0.1 }));
    await first.append(makeCostEntry({ usd: 0.2 }));
    await first.reset?.("inst-1");
    await first.append(makeCostEntry({ usd: 0.4 }));
    const second = fsCostLedger(dir);
    expect((await second.allTime("inst-1")).usd).toBe(0.4);
    expect((await second.forChange(FIXTURE_REPO, 1)).usd).toBe(0.7);
  });

  it("concurrent appends from two instances all land", async () => {
    const a = fsCostLedger(dir);
    const b = fsCostLedger(dir);
    await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).append(makeCostEntry({ usd: 0.01 }))));
    const s = await a.allTime("inst-1");
    expect(s.entries).toBe(50);
    expect(s.usd).toBe(0.5);
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
