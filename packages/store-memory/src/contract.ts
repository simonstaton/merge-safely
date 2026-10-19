/**
 * Shared contract suites for VerdictStore and CostLedger. Any implementation can run them:
 *
 *   verdictStoreContract("sqlite", async () => ({ store, close }));
 *   costLedgerContract("sqlite", async (clock) => ({ ledger, close }));
 *
 * vitest is loaded lazily so importing this package outside a test run never requires vitest to be installed.
 */
import type { CostLedger, VerdictStore } from "@merge-safely/core";
import { FIXTURE_REPO, fakeClock, makeCostEntry, makeVerdict } from "./fixtures.js";

type Vitest = typeof import("vitest");

let vitest: Vitest | undefined;
try {
  vitest = await import("vitest");
} catch (err: unknown) {
  void err;
  vitest = undefined;
}

function requireVitest(): Vitest {
  if (!vitest)
    throw new Error("@merge-safely/store-memory contract suites need vitest; run them from a vitest test file");
  return vitest;
}

export type VerdictStoreFactory = () => Promise<{ store: VerdictStore; close?: () => Promise<void> }>;
export type CostLedgerFactory = (clock: { now: () => Date }) => Promise<{
  ledger: CostLedger;
  close?: () => Promise<void>;
}>;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

export function verdictStoreContract(name: string, factory: VerdictStoreFactory): void {
  const { describe, it, expect, beforeEach, afterEach } = requireVitest();

  describe(`VerdictStore contract: ${name}`, () => {
    let store: VerdictStore;
    let close: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const made = await factory();
      store = made.store;
      close = made.close;
    });
    afterEach(async () => {
      await close?.();
    });

    it("get on a missing key returns null", async () => {
      expect(await store.get({ repo: FIXTURE_REPO, number: 1, headSha: SHA_A })).toBeNull();
    });

    it("put with expect null creates and returns a version", async () => {
      const v = makeVerdict();
      const res = await store.put(v, { version: null });
      expect(res.ok).toBe(true);
      expect(typeof res.version).toBe("string");
      expect(res.version.length).toBeGreaterThan(0);
      const got = await store.get(v);
      expect(got?.version).toBe(res.version);
      expect(got?.verdict).toEqual(v);
    });

    it("put with expect null fails when a verdict already exists", async () => {
      const first = await store.put(makeVerdict(), { version: null });
      const second = await store.put(makeVerdict({ decision: "block" }), { version: null });
      expect(second.ok).toBe(false);
      expect(second.version).toBe(first.version);
      expect((await store.get(makeVerdict()))?.verdict.decision).toBe("pass");
    });

    it("put with a stale version fails and leaves the stored verdict unchanged", async () => {
      const v1 = await store.put(makeVerdict({ round: 1 }), { version: null });
      const v2 = await store.put(makeVerdict({ round: 2 }), { version: v1.version });
      expect(v2.ok).toBe(true);
      const stale = await store.put(makeVerdict({ round: 3, decision: "block" }), { version: v1.version });
      expect(stale.ok).toBe(false);
      const got = await store.get(makeVerdict());
      expect(got?.verdict.round).toBe(2);
      expect(got?.verdict.decision).toBe("pass");
      expect(got?.version).toBe(v2.version);
    });

    it("put with a version on a missing key fails", async () => {
      const res = await store.put(makeVerdict(), { version: "does-not-exist" });
      expect(res.ok).toBe(false);
      expect(await store.get(makeVerdict())).toBeNull();
    });

    it("put with the correct version replaces and returns a new version", async () => {
      const v1 = await store.put(makeVerdict(), { version: null });
      const v2 = await store.put(makeVerdict({ decision: "block" }), { version: v1.version });
      expect(v2.ok).toBe(true);
      expect(v2.version).not.toBe(v1.version);
      const got = await store.get(makeVerdict());
      expect(got?.verdict.decision).toBe("block");
      expect(got?.version).toBe(v2.version);
    });

    it("versions are opaque strings that change on every successful put, even for identical content", async () => {
      const seen = new Set<string>();
      let version: string | null = null;
      for (let i = 0; i < 5; i++) {
        const res = await store.put(makeVerdict(), { version });
        expect(res.ok).toBe(true);
        expect(typeof res.version).toBe("string");
        expect(seen.has(res.version)).toBe(false);
        seen.add(res.version);
        version = res.version;
      }
    });

    it("concurrent creates with the same expect: exactly one succeeds", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.put(makeVerdict({ round: i + 1 }), { version: null })),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const got = await store.get(makeVerdict());
      expect(got?.version).toBe(winners[0]?.version);
    });

    it("concurrent updates with the same expect: exactly one succeeds", async () => {
      const base = await store.put(makeVerdict(), { version: null });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.put(makeVerdict({ round: i + 2 }), { version: base.version })),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const got = await store.get(makeVerdict());
      expect(got?.version).toBe(winners[0]?.version);
    });

    it("listForChange returns every SHA's latest verdict in createdAt order, and nothing from other changes", async () => {
      const b = await store.put(makeVerdict({ headSha: SHA_B, createdAt: "2026-01-03T00:00:00.000Z" }), {
        version: null,
      });
      await store.put(makeVerdict({ headSha: SHA_A, createdAt: "2026-01-01T00:00:00.000Z" }), { version: null });
      await store.put(makeVerdict({ headSha: SHA_C, createdAt: "2026-01-02T00:00:00.000Z" }), { version: null });
      // Latest for SHA_B replaces the earlier one.
      await store.put(makeVerdict({ headSha: SHA_B, round: 2, createdAt: "2026-01-04T00:00:00.000Z" }), {
        version: b.version,
      });
      // Other changes: different number, different repo.
      await store.put(makeVerdict({ number: 2 }), { version: null });
      await store.put(makeVerdict({ number: 11 }), { version: null });
      await store.put(makeVerdict({ repo: { ...FIXTURE_REPO, name: "other" } }), { version: null });

      const list = await store.listForChange(FIXTURE_REPO, 1);
      expect(list.map((v) => v.headSha)).toEqual([SHA_A, SHA_C, SHA_B]);
      expect(list[2]?.round).toBe(2);
      expect(list.every((v) => v.number === 1 && v.repo.name === "widgets")).toBe(true);
      expect(await store.listForChange(FIXTURE_REPO, 99)).toEqual([]);
    });

    it("keys are (host, owner, name, number, headSha) and SHAs compare case-insensitively", async () => {
      const upper = "ABCDEF0123456789".repeat(2);
      const res = await store.put(makeVerdict({ headSha: upper }), { version: null });
      expect(res.ok).toBe(true);
      const got = await store.get({ repo: FIXTURE_REPO, number: 1, headSha: upper.toLowerCase() });
      expect(got?.version).toBe(res.version);
      const dup = await store.put(makeVerdict({ headSha: upper.toLowerCase() }), { version: null });
      expect(dup.ok).toBe(false);

      for (const key of [
        { repo: { ...FIXTURE_REPO, host: "ghe.example.com" }, number: 1, headSha: upper },
        { repo: { ...FIXTURE_REPO, owner: "other" }, number: 1, headSha: upper },
        { repo: { ...FIXTURE_REPO, name: "other" }, number: 1, headSha: upper },
        { repo: FIXTURE_REPO, number: 2, headSha: upper },
        { repo: FIXTURE_REPO, number: 1, headSha: SHA_A },
      ]) {
        expect(await store.get(key)).toBeNull();
      }
    });
  });
}

export function costLedgerContract(name: string, factory: CostLedgerFactory): void {
  const { describe, it, expect, beforeEach, afterEach } = requireVitest();

  describe(`CostLedger contract: ${name}`, () => {
    let ledger: CostLedger;
    let close: (() => Promise<void>) | undefined;
    const clock = fakeClock("2026-01-10T00:00:00.000Z");

    beforeEach(async () => {
      clock.set("2026-01-10T00:00:00.000Z");
      const made = await factory({ now: clock.now });
      ledger = made.ledger;
      close = made.close;
    });
    afterEach(async () => {
      await close?.();
    });

    it("empty ledger sums to zero", async () => {
      const s = await ledger.forChange(FIXTURE_REPO, 1);
      expect(s.usd).toBe(0);
      expect(s.entries).toBe(0);
      expect(s.tokens.in).toBe(0);
      expect((await ledger.allTime("inst-1")).usd).toBe(0);
    });

    it("forChange sums usd and tokens exactly across rounds and SHAs", async () => {
      await ledger.append(makeCostEntry({ usd: 0.1, tokens: { in: 100, out: 10, cachedIn: 5 } }));
      await ledger.append(makeCostEntry({ usd: 0.2, round: 2, headSha: SHA_B, tokens: { in: 200, out: 20 } }));
      await ledger.append(makeCostEntry({ usd: 0.000001, tokens: { in: 1, out: 1, cacheWrite: 7 } }));
      await ledger.append(makeCostEntry({ number: 2, usd: 5, tokens: { in: 9, out: 9 } }));
      await ledger.append(makeCostEntry({ repo: { ...FIXTURE_REPO, name: "other" }, usd: 5 }));
      const s = await ledger.forChange(FIXTURE_REPO, 1);
      expect(s.usd).toBe(0.300001);
      expect(s.usd.toFixed(6)).toBe("0.300001");
      expect(s.tokens).toEqual({ in: 301, out: 31, cachedIn: 5, cacheWrite: 7 });
      expect(s.entries).toBe(3);
    });

    it("0.1 + 0.2 style sums come out exact", async () => {
      for (let i = 0; i < 10; i++) await ledger.append(makeCostEntry({ usd: 0.1 }));
      await ledger.append(makeCostEntry({ usd: 0.2 }));
      expect((await ledger.forChange(FIXTURE_REPO, 1)).usd).toBe(1.2);
      expect((await ledger.allTime("inst-1")).usd).toBe(1.2);
    });

    it("forChange includes entries without an installationId", async () => {
      await ledger.append(makeCostEntry({ usd: 1, installationId: undefined }));
      await ledger.append(makeCostEntry({ usd: 2 }));
      expect((await ledger.forChange(FIXTURE_REPO, 1)).usd).toBe(3);
    });

    it("forWindow only counts entries inside the window ending now", async () => {
      const hour = 3_600_000;
      await ledger.append(makeCostEntry({ usd: 1, at: "2026-01-09T23:30:00.000Z" })); // 30 min ago
      await ledger.append(makeCostEntry({ usd: 2, at: "2026-01-09T22:00:00.000Z" })); // 2 h ago
      await ledger.append(makeCostEntry({ usd: 4, at: "2026-01-08T00:00:00.000Z" })); // 2 days ago
      await ledger.append(makeCostEntry({ usd: 8, at: "2026-01-09T23:59:00.000Z", installationId: "inst-2" }));
      expect((await ledger.forWindow("inst-1", hour)).usd).toBe(1);
      expect((await ledger.forWindow("inst-1", 3 * hour)).usd).toBe(3);
      expect((await ledger.forWindow("inst-1", 7 * 24 * hour)).usd).toBe(7);
      expect((await ledger.forWindow("inst-1", 3 * hour)).entries).toBe(2);
      clock.advance(hour);
      expect((await ledger.forWindow("inst-1", hour)).usd).toBe(0);
      // The window is (now - windowMs, now]: an entry exactly at the lower edge is out.
      expect((await ledger.forWindow("inst-1", 3 * hour)).usd).toBe(1);
      expect((await ledger.forWindow("inst-1", 4 * hour)).usd).toBe(3);
    });

    it("an entry with an unparseable timestamp is recorded at append time, never dropped", async () => {
      await ledger.append(makeCostEntry({ usd: 0.5, at: "not-a-date" }));
      expect((await ledger.forWindow("inst-1", 60_000)).usd).toBe(0.5);
      expect((await ledger.allTime("inst-1")).usd).toBe(0.5);
    });

    it("allTime sums everything for the installation and nothing else", async () => {
      await ledger.append(makeCostEntry({ usd: 1.5, at: "2020-01-01T00:00:00.000Z" }));
      await ledger.append(makeCostEntry({ usd: 2.25, number: 7 }));
      await ledger.append(makeCostEntry({ usd: 100, installationId: "inst-2" }));
      const s = await ledger.allTime("inst-1");
      expect(s.usd).toBe(3.75);
      expect(s.entries).toBe(2);
      expect((await ledger.allTime("inst-2")).usd).toBe(100);
      expect((await ledger.allTime("inst-3")).entries).toBe(0);
    });

    it("entries without installationId are excluded from window and allTime", async () => {
      await ledger.append(makeCostEntry({ usd: 9, installationId: undefined, at: "2026-01-09T23:59:00.000Z" }));
      await ledger.append(makeCostEntry({ usd: 1, at: "2026-01-09T23:59:00.000Z" }));
      expect((await ledger.forWindow("inst-1", 3_600_000)).usd).toBe(1);
      expect((await ledger.allTime("inst-1")).usd).toBe(1);
      expect((await ledger.allTime("_")).usd).toBe(0);
      expect((await ledger.allTime("")).usd).toBe(0);
    });

    it("reset zeroes allTime from a rollup baseline but keeps forChange history", async () => {
      if (!ledger.reset) throw new Error("reset is required by this contract");
      await ledger.append(makeCostEntry({ usd: 0.1, tokens: { in: 10, out: 1 } }));
      await ledger.append(makeCostEntry({ usd: 0.2, tokens: { in: 20, out: 2 } }));
      await ledger.append(makeCostEntry({ usd: 50, installationId: "inst-2" }));
      await ledger.reset("inst-1");

      const after = await ledger.allTime("inst-1");
      expect(after.usd).toBe(0);
      expect(after.entries).toBe(0);
      expect(after.tokens.in).toBe(0);
      expect((await ledger.allTime("inst-2")).usd).toBe(50);
      expect((await ledger.forChange(FIXTURE_REPO, 1)).usd).toBe(50.3);

      await ledger.append(makeCostEntry({ usd: 0.7, tokens: { in: 7, out: 7 } }));
      const later = await ledger.allTime("inst-1");
      expect(later.usd).toBe(0.7);
      expect(later.entries).toBe(1);
      expect(later.tokens.in).toBe(7);
      expect((await ledger.forChange(FIXTURE_REPO, 1)).usd).toBe(51);
    });
  });
}
