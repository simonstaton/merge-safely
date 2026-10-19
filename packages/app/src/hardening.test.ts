import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "@merge-safely/core";
import { createProviderRegistry, encryptSecret } from "@merge-safely/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp } from "./app.js";
import { AppDb, connectionAad } from "./db.js";
import { createLogger, SECRET_LRU_CAPACITY, SecretSet } from "./logger.js";
import { rotateKey } from "./main.js";
import { MetricsRegistry } from "./metrics.js";
import { classifyError, isRateLimited, retryAfterMs, Worker } from "./queue.js";
import {
  type FakeOctokitOptions,
  fakeOctokit,
  fakeVerdict,
  HEAD_SHA,
  recordingGate,
  sign,
  TEST_MASTER_KEY,
  TEST_SETUP_TOKEN,
  TEST_WEBHOOK_SECRET,
  testConfig,
} from "./testing.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ms-app-hard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  app: App;
  base: string;
  gate: ReturnType<typeof recordingGate>;
  octoOpts: FakeOctokitOptions;
  logs: string[];
  hook(event: string, payload: unknown): Promise<Response>;
}

async function harness(octoOpts: FakeOctokitOptions = { baseRef: "main" }): Promise<Harness> {
  const gate = recordingGate();
  const logs: string[] = [];
  const secrets = new SecretSet();
  const app = createApp({
    config: testConfig(dir),
    secrets,
    logger: createLogger({ level: "debug", secrets, write: (l) => logs.push(l) }),
    octokitFor: () => fakeOctokit(octoOpts),
    gateFactory: gate.factory,
    registry: createProviderRegistry([]),
    workspaceFactory: () => ({ acquire: async () => Promise.reject(new Error("no workspace")) }),
    worker: { pollMs: 5, backoffBaseMs: 1 },
  });
  app.db.upsertInstallation(42, "acme");
  await app.start();
  const port = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const hook = (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": sign(TEST_WEBHOOK_SECRET, body),
      },
      body,
    });
  };
  return { app, base, gate, octoOpts, logs, hook };
}

const pr = (action: string, extra: Record<string, unknown> = {}, base = "main") => ({
  action,
  number: 7,
  installation: { id: 42, account: { login: "acme" } },
  repository: { name: "r", owner: { login: "o" }, html_url: "https://github.com/o/r" },
  pull_request: { number: 7, draft: false, head: { sha: HEAD_SHA }, base: { ref: base } },
  ...extra,
});

describe("retarget (base-changed) mid-review", () => {
  it("never coalesces into the running job; supersedes it and re-reviews under the new base with trigger base-changed", async () => {
    const h = await harness({
      baseRef: "weak",
      policies: { weak: "budget:\n  perChangeUsd: 999\n", main: "budget:\n  perChangeUsd: 2\n" },
    });
    let release: () => void = () => {};
    h.gate.review = async (n: number): Promise<Verdict> => {
      if (n === 1) await new Promise<void>((r) => (release = r));
      return fakeVerdict();
    };
    const first = (await (await h.hook("pull_request", pr("opened", {}, "weak"))).json()) as { queued: number };
    await until(() => h.app.db.getJob(first.queued)?.state === "running");
    // Retarget weak -> main while the review is running: same head SHA.
    h.octoOpts.baseRef = "main";
    const retarget = await h.hook(
      "pull_request",
      pr("edited", { changes: { base: { ref: { from: "weak" } } } }, "main"),
    );
    const body = (await retarget.json()) as { queued: number; coalesced: boolean; superseded: number[] };
    expect(body.coalesced).toBe(false);
    expect(body.queued).not.toBe(first.queued);
    expect(body.superseded).toEqual([first.queued]);
    // A plain duplicate of the retarget still coalesces into the new job.
    const dup = (await (await h.hook("pull_request", pr("reopened", {}, "main"))).json()) as { queued: number };
    expect(dup.queued).toBe(body.queued);
    release();
    await until(() => h.app.db.getJob(body.queued)?.state === "done");
    expect(h.app.db.getJob(first.queued)?.state).toBe("superseded");
    expect(h.gate.reviews).toHaveLength(2);
    expect(h.gate.reviews[1]?.opts).toMatchObject({ headSha: HEAD_SHA, trigger: "base-changed" });
    expect(h.gate.deps[1]?.policy.budget.perChangeUsd).toBe(2);
    const row = h.app.db.getJob(body.queued);
    expect(row).toMatchObject({ base_ref: "main", policy_source: "file", trigger: "base-changed" });
    await h.app.close(1000);
  });

  it("does not coalesce an event naming a different base than the open job read", async () => {
    const db = new AppDb({ path: join(dir, "x.db"), masterKey: TEST_MASTER_KEY });
    const j = { installationId: 1, repo: "o/r", number: 1, headSha: "a".repeat(40), event: "e" };
    const a = db.enqueue({ ...j, baseRef: "dev" });
    expect(db.enqueue({ ...j, baseRef: "dev" }).coalesced).toBe(true);
    const b = db.enqueue({ ...j, baseRef: "main" });
    expect(b.coalesced).toBe(false);
    expect(b.supersededQueued).toEqual([a.id]);
    db.close();
  });
});

describe("crash-loop guard", () => {
  it("re-queues an interrupted job until it has crashed the process too often, then fails it and reports", async () => {
    const path = join(dir, "c.db");
    let db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const { id } = db.enqueue({ installationId: 1, repo: "o/r", number: 1, headSha: "a".repeat(40), event: "e" });
    db.claimNext(); // attempts 1, then the process dies
    db.close();
    db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    expect(db.requeueInterrupted()).toMatchObject({ requeued: 1, failed: [] }); // attempts 2
    db.claimNext(); // attempts 3, dies again
    db.close();
    db = new AppDb({ path, masterKey: TEST_MASTER_KEY });
    const reported: string[] = [];
    const w = new Worker({
      db,
      run: async () => ({ outcome: "never" }),
      logger: createLogger({ level: "error", write: () => {} }),
      secrets: new SecretSet(),
      metrics: new MetricsRegistry(),
      pollMs: 5,
      onFinalFailure: async (_j, m) => void reported.push(m),
    });
    w.start();
    await until(() => reported.length === 1);
    expect(db.getJob(id)).toMatchObject({ state: "failed" });
    expect(db.getJob(id)?.error).toMatch(/crashed repeatedly/);
    expect(reported[0]).toMatch(/crashed the service repeatedly/);
    await w.stop();
    db.close();
  });

  it("backs off instead of throwing when the database refuses a claim", async () => {
    const db = new AppDb({ path: join(dir, "b.db"), masterKey: TEST_MASTER_KEY });
    let claims = 0;
    const orig = db.claimNext.bind(db);
    db.claimNext = () => {
      claims++;
      if (claims < 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return orig();
    };
    const { id } = db.enqueue({ installationId: 1, repo: "o/r", number: 1, headSha: "a".repeat(40), event: "e" });
    const lines: string[] = [];
    const w = new Worker({
      db,
      run: async () => ({ outcome: "ok" }),
      logger: createLogger({ level: "error", write: (l) => lines.push(l) }),
      secrets: new SecretSet(),
      metrics: new MetricsRegistry(),
      pollMs: 2,
    });
    w.start();
    await until(() => db.getJob(id)?.state === "done");
    expect(lines.some((l) => l.includes("backing off"))).toBe(true);
    await w.stop();
    db.close();
  });

  it("never overlaps ticks", async () => {
    const db = new AppDb({ path: join(dir, "t.db"), masterKey: TEST_MASTER_KEY });
    let active = 0;
    let peak = 0;
    const w = new Worker({
      db,
      run: async () => ({ outcome: "x" }),
      logger: createLogger({ level: "error", write: () => {} }),
      secrets: new SecretSet(),
      metrics: new MetricsRegistry(),
      onTick: async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(20);
        active--;
      },
    });
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(peak).toBe(1);
    db.close();
  });
});

describe("403 classification", () => {
  const err = (message: string, headers: Record<string, string> = {}) =>
    Object.assign(new Error(message), { status: 403, response: { headers } });
  it("retries only rate-limit 403s and honours retry-after", () => {
    expect(classifyError(err("Resource not accessible by integration"))).toBe("fail");
    expect(classifyError(err("This installation has been suspended"))).toBe("fail");
    expect(classifyError(err("API rate limit exceeded", { "x-ratelimit-remaining": "0" }))).toBe("retry");
    expect(classifyError(err("You have exceeded a secondary rate limit"))).toBe("retry");
    expect(isRateLimited(err("x", { "retry-after": "30" }))).toBe(true);
    expect(retryAfterMs(err("x", { "retry-after": "30" }))).toBe(30_000);
    expect(retryAfterMs(err("x", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "110" }), 100_000)).toBe(10_000);
    expect(retryAfterMs(err("x"))).toBeUndefined();
  });
});

describe("installation lifecycle", () => {
  it("uninstall purges cloned source and worktrees; late PR webhooks do not resurrect it", async () => {
    const h = await harness();
    const mirror = join(dir, "repos", "42", "o__r.git");
    const other = join(dir, "repos", "43", "o__r.git");
    const wt = join(dir, "worktrees", "42", "seat");
    for (const d of [mirror, other, wt]) mkdirSync(d, { recursive: true });
    writeFileSync(join(mirror, "HEAD"), "ref: x");
    await h.hook("installation", { action: "deleted", installation: { id: 42, account: { login: "acme" } } });
    await until(() => !existsSync(mirror) && !existsSync(wt));
    expect(existsSync(other)).toBe(true);
    const late = await h.hook("pull_request", pr("opened"));
    expect(await late.json()).toMatchObject({ ignored: true, reason: "unknown installation" });
    expect(h.app.db.getInstallation(42)?.deleted_at).not.toBeNull();
    expect(h.logs.some((l) => l.includes("unknown or uninstalled installation"))).toBe(true);
    await h.app.close(1000);
  });

  it("repositories removed from an installation lose their mirrors and queued jobs", async () => {
    const h = await harness();
    await h.app.worker.stop(0);
    const mirror = join(dir, "repos", "42", "o__r.git");
    const keep = join(dir, "repos", "42", "o__keep.git");
    mkdirSync(mirror, { recursive: true });
    mkdirSync(keep, { recursive: true });
    const { queued } = (await (await h.hook("pull_request", pr("opened"))).json()) as { queued: number };
    await h.hook("installation_repositories", {
      action: "removed",
      installation: { id: 42, account: { login: "acme" } },
      repositories_removed: [{ full_name: "o/r" }],
    });
    await until(() => !existsSync(mirror));
    expect(existsSync(keep)).toBe(true);
    expect(h.app.db.getJob(queued)?.state).toBe("failed");
    await h.app.close(1000);
  });

  it("suspension fails queued jobs; closing a PR cancels its queued jobs", async () => {
    const h = await harness();
    await h.app.worker.stop(0);
    const a = (await (await h.hook("pull_request", pr("opened"))).json()) as { queued: number };
    const closed = await h.hook("pull_request", pr("closed"));
    expect(await closed.json()).toMatchObject({ cancelled: 1 });
    expect(h.app.db.getJob(a.queued)?.state).toBe("superseded");
    const b = (await (await h.hook("pull_request", pr("reopened"))).json()) as { queued: number };
    await h.hook("installation", { action: "suspend", installation: { id: 42, account: { login: "acme" } } });
    expect(h.app.db.getJob(b.queued)?.state).toBe("failed");
    await h.app.close(1000);
  });

  it("syncs installations from GitHub at boot without resurrecting uninstalled ones", async () => {
    const pre = new AppDb({ path: join(dir, "app.db"), masterKey: TEST_MASTER_KEY });
    pre.upsertInstallation(5, "gone");
    pre.deleteInstallation(5);
    pre.close();
    const app = createApp({
      config: testConfig(dir),
      logger: createLogger({ level: "error", write: () => {} }),
      octokitFor: () => fakeOctokit(),
      syncInstallations: async () => [
        { id: 5, account: "gone" },
        { id: 6, account: "new-org" },
      ],
    });
    await app.start();
    expect(app.db.isActiveInstallation(6)).toBe(true);
    expect(app.db.isActiveInstallation(5)).toBe(false);
    await app.close(100);
  });
});

describe("http hardening", () => {
  it("answers a cross-origin preflight with 401 and no CORS headers; no details link on check runs", async () => {
    const h = await harness();
    const r = await fetch(`${h.base}/setup/budget`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const { queued } = (await (await h.hook("pull_request", pr("opened"))).json()) as { queued: number };
    await until(() => h.app.db.getJob(queued)?.state === "done");
    expect(JSON.stringify(h.gate.deps[0]?.reporters ?? [])).not.toContain("/installations/");
    await h.app.close(1000);
  });
});

describe("secret scrubbing", () => {
  it("matches JSON-escaped secrets and keeps the per-line set bounded", () => {
    const secrets = new SecretSet();
    secrets.addLongLived('pa"ss\\word-123');
    const lines: string[] = [];
    createLogger({ secrets, write: (l) => lines.push(l) }).info('leak pa"ss\\word-123');
    expect(lines[0]).not.toContain("word-123");
    for (let i = 0; i < SECRET_LRU_CAPACITY + 50; i++) secrets.add(`token-value-${i}`);
    expect(secrets.size()).toBe(SECRET_LRU_CAPACITY + 1);
    expect(secrets.scrub("token-value-249 and token-value-0")).toContain("token-value-0"); // evicted
    expect(secrets.scrub('pa"ss\\word-123')).not.toContain("word-123"); // long-lived survives
  });
});

describe("master key", () => {
  it("a passphrase is derived once per deployment salt and round-trips across restarts", () => {
    const path = join(dir, "p.db");
    const pass = "correct horse battery staple";
    const a = new AppDb({ path, masterKey: pass });
    a.saveConnection(1, {
      id: "c",
      provider: "anthropic",
      kind: "api-key",
      createdAt: "x",
      secret: { kind: "api-key", apiKey: "sk-ant-pp-123456" },
    });
    a.close();
    const b = new AppDb({ path, masterKey: pass });
    expect(b.loadConnections(1).connections[0]?.secret).toEqual({ kind: "api-key", apiKey: "sk-ant-pp-123456" });
    b.close();
    expect(new AppDb({ path, masterKey: "another passphrase!!" }).loadConnections(1).problems).toHaveLength(1);
  });

  it("rotate-key re-encrypts every connection, is re-runnable, and reports undecryptable rows", () => {
    const path = join(dir, "app.db");
    const oldKey = TEST_MASTER_KEY;
    const newKey = "b".repeat(64);
    const db = new AppDb({ path, masterKey: oldKey });
    for (const id of ["one", "two"]) {
      db.saveConnection(9, {
        id,
        provider: "anthropic",
        kind: "api-key",
        createdAt: "x",
        secret: { kind: "api-key", apiKey: `sk-ant-${id}-123456` },
      });
    }
    db.db
      .prepare("INSERT INTO connections (installation_id, id, record_json, secret_blob) VALUES (9, 'junk', ?, ?)")
      .run(
        JSON.stringify({ id: "junk", provider: "anthropic", kind: "api-key", createdAt: "x" }),
        encryptSecret({ kind: "api-key", apiKey: "zzzzzzzz" }, "c".repeat(64), connectionAad(9, "junk")),
      );
    db.close();
    const out: string[] = [];
    const env = { MERGE_SAFELY_MASTER_KEY: newKey, MERGE_SAFELY_MASTER_KEY_OLD: oldKey, DATABASE: path };
    expect(rotateKey(env, (l) => out.push(l))).toBe(1);
    expect(out[0]).toMatch(/re-encrypted 2 connection\(s\); 0 already under the new key; 1 failed/);
    expect(rotateKey(env, (l) => out.push(l))).toBe(1);
    expect(out.join("\n")).toMatch(/re-encrypted 0 connection\(s\); 2 already/);
    const after = new AppDb({ path, masterKey: newKey });
    expect(after.loadConnections(9).connections.map((c) => c.id)).toEqual(["one", "two"]);
    after.close();
    expect(rotateKey({ MERGE_SAFELY_MASTER_KEY: newKey }, () => {})).toBe(2);
  });
});

describe("setup page token", () => {
  it("still requires the bearer for every POST", async () => {
    const h = await harness();
    const r = await fetch(`${h.base}/setup/connections/delete`, { method: "POST", body: "installation=42&id=x" });
    expect(r.status).toBe(401);
    const ok = await fetch(`${h.base}/setup?installation_id=42`, {
      headers: { authorization: `Bearer ${TEST_SETUP_TOKEN}` },
    });
    expect(await ok.text()).toContain("acme (42)");
    await h.app.close(1000);
  });
});
