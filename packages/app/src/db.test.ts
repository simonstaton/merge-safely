import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, DEFAULT_POLICY } from "@merge-safely/core";
import { decryptSecret, encryptSecret } from "@merge-safely/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDb, connectionAad } from "./db.js";
import { createLogger } from "./logger.js";
import {
  applyBudgetOverrides,
  emptyOverrides,
  loadBudgetOverrides,
  loadLatch,
  parseOverrideField,
  saveBudgetOverrides,
  saveLatch,
} from "./settings.js";
import { TEST_MASTER_KEY } from "./testing.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ms-app-db-"));
  path = join(dir, "app.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const conn = (id: string, apiKey = "sk-ant-secret-value-1234"): Connection => ({
  id,
  provider: "anthropic",
  kind: "api-key",
  createdAt: "2026-10-19T00:00:00.000Z",
  secret: { kind: "api-key", apiKey },
});

describe("migrations", () => {
  it("are idempotent across reopen", () => {
    const a = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    a.migrate();
    a.upsertInstallation(1, "acme");
    a.close();
    const b = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    expect(b.schemaVersion()).toBe(1);
    expect(b.listInstallations().map((i) => i.account)).toEqual(["acme"]);
    b.close();
  });
});

describe("connections", () => {
  it("round-trip encrypted with a per-installation AAD and never store the secret in clear", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    db.saveConnection(1, conn("main"));
    const raw = db.db.prepare("SELECT record_json, secret_blob, hint FROM connections").get() as Record<string, string>;
    expect(JSON.stringify(raw)).not.toContain("sk-ant-secret-value-1234");
    expect(raw.hint).toContain("…1234");
    expect(db.loadConnections(1).connections[0]?.secret).toEqual({
      kind: "api-key",
      apiKey: "sk-ant-secret-value-1234",
    });
    expect(db.listConnections(1)[0]?.record).not.toHaveProperty("secret");
    // The blob only opens under its own installation:id.
    expect(decryptSecret(raw.secret_blob ?? "", TEST_MASTER_KEY, connectionAad(1, "main"))).toBeTruthy();
    expect(() => decryptSecret(raw.secret_blob ?? "", TEST_MASTER_KEY, connectionAad(2, "main"))).toThrow();
    db.close();
  });

  it("reports (does not throw) a blob copied to another installation or opened with the wrong key", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const blob = encryptSecret(conn("main").secret, TEST_MASTER_KEY, connectionAad(1, "main"));
    db.db
      .prepare("INSERT INTO connections (installation_id, id, record_json, secret_blob) VALUES (2, 'main', ?, ?)")
      .run(JSON.stringify({ id: "main", provider: "anthropic", kind: "api-key", createdAt: "x" }), blob);
    const r = db.loadConnections(2);
    expect(r.connections).toEqual([]);
    expect(r.problems[0]?.message).toMatch(/re-connect/);
    db.saveConnection(3, conn("x"));
    db.close();
    const wrong = new AppDb({ path, masterKey: "b".repeat(64) });
    expect(wrong.loadConnections(3).problems).toHaveLength(1);
    wrong.close();
  });

  it("purges secrets and settings when the installation is deleted", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    db.upsertInstallation(1, "acme");
    db.saveConnection(1, conn("main"));
    db.setSetting(1, "budget.windowUsd", 5);
    db.deleteInstallation(1);
    expect(db.listConnections(1)).toEqual([]);
    expect(db.getSetting(1, "budget.windowUsd").found).toBe(false);
    expect(db.listInstallations()).toEqual([]);
    db.close();
  });
});

describe("settings", () => {
  it("restores null (never configured) and 0 (disabled) distinctly after a restart", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    saveBudgetOverrides(db, 1, {
      perChangeUsd: 0,
      windowUsd: null,
      spendLimitUsd: 12.5,
      perInstallationMonthlyUsd: null,
    });
    db.close();
    const again = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const o = loadBudgetOverrides(again, 1);
    expect(o).toEqual({ perChangeUsd: 0, windowUsd: null, spendLimitUsd: 12.5, perInstallationMonthlyUsd: null });
    const p = applyBudgetOverrides({ ...DEFAULT_POLICY, budget: { ...DEFAULT_POLICY.budget, windowUsd: 40 } }, o);
    expect(p.budget.perChangeUsd).toBe(0); // explicitly disabled
    expect(p.budget.windowUsd).toBe(40); // null keeps the policy value
    expect(p.budget.spendLimitUsd).toBe(12.5);
    again.close();
  });

  it("falls back to null with a logged error for a corrupt stored value", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    db.setSettingRaw(1, "budget.windowUsd", '"-3"');
    db.setSettingRaw(1, "budget.spendLimitUsd", "{not json");
    const lines: string[] = [];
    const o = loadBudgetOverrides(db, 1, createLogger({ write: (l) => lines.push(l) }));
    expect(o).toEqual(emptyOverrides());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/invalid/);
    db.close();
  });

  it("parses form fields: empty is null, 0 is 0, junk is rejected", () => {
    expect(parseOverrideField("")).toEqual({ ok: true, value: null });
    expect(parseOverrideField(" 0 ")).toEqual({ ok: true, value: 0 });
    expect(parseOverrideField("2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseOverrideField("-1").ok).toBe(false);
    expect(parseOverrideField("1e9").ok).toBe(false);
  });

  it("persists the alert latch", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const latch = loadLatch(db, 1, [0.5, 1]);
    expect(latch.observe("window", 0.6)).toHaveLength(1);
    saveLatch(db, 1, latch);
    const restored = loadLatch(db, 1, [0.5, 1]);
    expect(restored.observe("window", 0.7)).toHaveLength(0);
    db.close();
  });
});

describe("jobs", () => {
  const job = { installationId: 1, repo: "o/r", number: 7, headSha: "a".repeat(40), event: "pull_request.opened" };

  it("coalesces duplicates and supersedes older SHAs", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const a = db.enqueue(job);
    expect(db.enqueue(job)).toMatchObject({ id: a.id, coalesced: true });
    const b = db.enqueue({ ...job, headSha: "b".repeat(40) });
    expect(b.supersededQueued).toEqual([a.id]);
    expect(db.getJob(a.id)?.state).toBe("superseded");
    const claimed = db.claimNext();
    expect(claimed?.id).toBe(b.id);
    const c = db.enqueue({ ...job, headSha: "c".repeat(40) });
    expect(c.supersededRunning).toEqual([b.id]);
    expect(db.finishJob(b.id, "done")).toBe("superseded");
    expect(db.countByState()).toMatchObject({ queued: 1, superseded: 2 });
    db.close();
  });

  it("never runs two jobs for one PR at once, and re-queues interrupted jobs at boot", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    db.enqueue(job);
    db.enqueue({ ...job, number: 8 });
    const first = db.claimNext();
    db.enqueue({ ...job, headSha: "d".repeat(40) });
    const second = db.claimNext();
    expect(second?.number).toBe(8);
    expect(db.claimNext()).toBeUndefined(); // PR 7's newer job waits for the running one
    db.close();
    const reboot = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    expect(reboot.requeueInterrupted()).toBe(2);
    expect(reboot.getJob(first?.id ?? 0)?.state).toBe("queued");
    reboot.close();
  });

  it("dedupes delivery ids", () => {
    const db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    expect(db.recordDelivery("d1")).toBe(true);
    expect(db.recordDelivery("d1")).toBe(false);
    db.forgetDelivery("d1");
    expect(db.recordDelivery("d1")).toBe(true);
    db.close();
  });
});
