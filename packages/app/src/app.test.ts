import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection, ModelProvider } from "@merge-safely/core";
import { createProviderRegistry } from "@merge-safely/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp } from "./app.js";
import { createLogger, SecretSet } from "./logger.js";
import {
  fakeOctokit,
  HEAD_SHA,
  recordingGate,
  sign,
  TEST_SETUP_TOKEN,
  TEST_WEBHOOK_SECRET,
  testConfig,
} from "./testing.js";

const KEY = "sk-ant-api03-supersecretkeyvalue-XYZ9";

const fakeProvider: ModelProvider = {
  id: "anthropic",
  connectionKinds: ["api-key", "oauth", "anthropic-compatible", "subscription"],
  async validate(conn: Connection) {
    if (conn.secret.kind === "api-key" && conn.secret.apiKey === KEY) {
      return {
        ok: true,
        latencyMs: 12,
        models: [
          {
            provider: "anthropic",
            name: "claude-sonnet-x",
            tier: "mid",
            supportsTools: true,
            supportsStructuredOutput: true,
            contextTokens: 200000,
            maxOutputTokens: 8000,
            pricing: { inPerMTok: 3, outPerMTok: 15 },
          },
          {
            provider: "anthropic",
            name: "<img src=x onerror=alert(1)>",
            tier: "small",
            supportsTools: true,
            supportsStructuredOutput: true,
            contextTokens: 1000,
            maxOutputTokens: 100,
          },
        ],
      };
    }
    return { ok: false, message: `invalid x-api-key ${conn.secret.kind === "api-key" ? conn.secret.apiKey : ""}` };
  },
  async models() {
    return [];
  },
  createRunner() {
    throw new Error("not in tests");
  },
};

let dir: string;
let app: App;
let base: string;
let logs: string[];
let gate: ReturnType<typeof recordingGate>;
let octo: ReturnType<typeof fakeOctokit>;

async function boot(policies: Record<string, string> = {}) {
  gate = recordingGate();
  octo = fakeOctokit({ policies, baseRef: "main" });
  logs = [];
  const secrets = new SecretSet();
  app = createApp({
    config: testConfig(dir),
    secrets,
    logger: createLogger({ level: "debug", secrets, write: (l) => logs.push(l) }),
    octokitFor: () => octo,
    gateFactory: gate.factory,
    registry: createProviderRegistry([fakeProvider]),
    workspaceFactory: () => ({
      acquire: async () => {
        throw new Error("no workspace in tests");
      },
    }),
    worker: { pollMs: 5, backoffBaseMs: 1 },
  });
  app.db.upsertInstallation(42, "acme");
  await app.start();
  const port = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ms-app-"));
  await boot();
});
afterEach(async () => {
  await app.close(1000);
  rmSync(dir, { recursive: true, force: true });
});

const prPayload = (over: Record<string, unknown> = {}, prOver: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  installation: { id: 42, account: { login: "acme" } },
  repository: { name: "r", owner: { login: "o" }, html_url: "https://github.com/o/r" },
  pull_request: { number: 7, draft: false, head: { sha: HEAD_SHA }, base: { ref: "main" }, ...prOver },
  ...over,
});

async function hook(event: string, payload: unknown, opts: { delivery?: string; secret?: string; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  return fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
      "x-hub-signature-256": sign(opts.secret ?? TEST_WEBHOOK_SECRET, body),
    },
    body,
  });
}

const auth = { authorization: `Bearer ${TEST_SETUP_TOKEN}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

describe("webhooks", () => {
  it("rejects a bad signature", async () => {
    const r = await hook("pull_request", prPayload(), { secret: "wrong-secret-wrong-secret" });
    expect(r.status).toBe(401);
    expect(app.db.countByState().queued).toBe(0);
  });

  it("rejects bodies over 5 MB", async () => {
    const r = await hook("pull_request", null, { raw: "x".repeat(5 * 1024 * 1024 + 10) });
    expect(r.status).toBe(413);
  });

  it("enqueues a reviewable PR event, runs it, and dedupes redeliveries", async () => {
    const r = await hook("pull_request", prPayload(), { delivery: "d-1" });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { queued: number };
    expect((await hook("pull_request", prPayload(), { delivery: "d-1" })).status).toBe(200);
    await until(() => app.db.getJob(body.queued)?.state === "done");
    expect(gate.reviews).toHaveLength(1);
    expect(gate.reviews[0]?.opts).toMatchObject({ headSha: HEAD_SHA });
    expect(app.db.getInstallation(42)?.account).toBe("acme");
  });

  it("coalesces duplicate events for the same head sha", async () => {
    await app.worker.stop(0); // keep jobs queued
    const a = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    const b = (await (await hook("pull_request", prPayload({ action: "reopened" }))).json()) as {
      queued: number;
      coalesced: boolean;
    };
    expect(b).toMatchObject({ queued: a.queued, coalesced: true });
    const c = (await (
      await hook("pull_request", prPayload({ action: "synchronize" }, { head: { sha: "f".repeat(40) } }))
    ).json()) as {
      superseded: number[];
    };
    expect(c.superseded).toEqual([a.queued]);
  });

  it("ignores drafts but reviews ready_for_review", async () => {
    const d = await hook("pull_request", prPayload({}, { draft: true }));
    expect(await d.json()).toMatchObject({ ignored: true, reason: "draft pull request" });
    const ready = await hook("pull_request", prPayload({ action: "ready_for_review" }, { draft: true }));
    expect(ready.status).toBe(202);
    expect(await ready.json()).toHaveProperty("queued");
  });

  it("maintains installations from installation events", async () => {
    await hook("installation", { action: "created", installation: { id: 9, account: { login: "org9" } } });
    expect(app.db.getInstallation(9)?.account).toBe("org9");
    await hook("installation_repositories", { action: "added", installation: { id: 10, account: { login: "org10" } } });
    expect(app.db.getInstallation(10)?.account).toBe("org10");
    await hook("installation", { action: "deleted", installation: { id: 9, account: { login: "org9" } } });
    expect(app.db.getInstallation(9)?.deleted_at).not.toBeNull();
  });

  it("ignores events that are not reviewable", async () => {
    const r = await hook("pull_request", prPayload({ action: "closed" }));
    expect(await r.json()).toMatchObject({ ignored: true });
    expect((await hook("ping", { zen: "x" })).status).toBe(200);
  });
});

describe("run-job pipeline", () => {
  it("reads the policy from the BASE branch, never the head, and records base ref + policy hash", async () => {
    await app.close(1000);
    await boot({ main: "budget:\n  perChangeUsd: 3\n", [HEAD_SHA]: "budget:\n  perChangeUsd: 9999\n" });
    const { queued } = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    await until(() => app.db.getJob(queued)?.state === "done");
    const contents = octo.calls.filter((c) => c.method === "repos.getContent");
    expect(contents.map((c) => (c.params as { ref: string }).ref)).toEqual(["main"]);
    expect(gate.deps[0]?.policy.budget.perChangeUsd).toBe(3);
    expect(gate.deps[0]?.installationId).toBe("42");
    const row = app.db.getJob(queued);
    expect(row?.base_ref).toBe("main");
    expect(row?.policy_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.outcome).toBe("pass");
    expect(gate.deps[0]?.reporters.length).toBeGreaterThanOrEqual(2);
  });

  it("an invalid policy fails the check run with the errors and calls no model", async () => {
    await app.close(1000);
    await boot({ main: "budget:\n  perChangeUsd: -1\n  bogus: 1\n" });
    const { queued } = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    await until(() => app.db.getJob(queued)?.state === "done");
    expect(app.db.getJob(queued)?.outcome).toBe("invalid-policy");
    expect(gate.deps).toHaveLength(0);
    const created = octo.calls.find((c) => c.method === "checks.create")?.params as {
      conclusion: string;
      head_sha: string;
      output: { summary: string };
    };
    expect(created.conclusion).toBe("failure");
    expect(created.head_sha).toBe(HEAD_SHA);
    expect(created.output.summary).toMatch(/perChangeUsd/);
  });

  it("applies installation budget overrides and passes the token to the workspace, not the URL", async () => {
    await app.close(1000);
    let wsOpts: Record<string, unknown> = {};
    gate = recordingGate();
    octo = fakeOctokit({ baseRef: "main" });
    app = createApp({
      config: testConfig(dir),
      logger: createLogger({ level: "error", write: () => {} }),
      octokitFor: () => octo,
      gateFactory: gate.factory,
      registry: createProviderRegistry([fakeProvider]),
      workspaceFactory: (o) => {
        wsOpts = { ...o };
        return {
          acquire: async () => {
            throw new Error("x");
          },
        };
      },
      worker: { pollMs: 5 },
    });
    app.db.upsertInstallation(42, "acme");
    app.db.setSetting(42, "budget.windowUsd", 0);
    app.db.setSetting(42, "budget.spendLimitUsd", 50);
    await app.start();
    const id = app.db.enqueue({ installationId: 42, repo: "o/r", number: 7, headSha: HEAD_SHA, event: "test" }).id;
    app.worker.pump();
    await until(() => app.db.getJob(id)?.state === "done");
    expect(gate.deps[0]?.policy.budget).toMatchObject({ windowUsd: 0, spendLimitUsd: 50 });
    expect(wsOpts.cloneUrl).toBe("https://github.com/o/r.git");
    expect(wsOpts.token).toMatch(/^ghs_/);
    expect(String(wsOpts.cacheDir)).toContain(join(dir, "repos", "42"));
    expect(String(wsOpts.worktreeRoot)).toBe(join(dir, "worktrees", "42"));
  });

  it("a failing gate is retried and finally reported on the check run, with secrets scrubbed from logs", async () => {
    gate.review = async () => {
      throw Object.assign(new Error(`upstream broke token ghs_faketokenfaketokenfaketoken0000`), {
        name: "GateError",
        code: "source",
      });
    };
    const { queued } = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    await until(() => app.db.getJob(queued)?.state === "failed", 5000);
    expect(app.db.getJob(queued)?.attempts).toBe(4);
    expect(logs.join("\n")).not.toContain("ghs_faketokenfaketokenfaketoken0000");
    expect(app.db.getJob(queued)?.error).not.toContain("ghs_faketoken");
    expect(octo.calls.some((c) => c.method === "checks.create")).toBe(true);
  });
});

describe("setup page", () => {
  beforeEach(() => app.db.upsertInstallation(42, '<script>alert("acme")</script>'));

  it("requires the bearer token (no cookie, no query token)", async () => {
    const r = await fetch(`${base}/setup?installation=42`);
    expect(r.status).toBe(401);
    const html = await r.text();
    expect(html).toContain('id="app"');
    expect(html).not.toContain("acme");
    expect((await fetch(`${base}/setup?installation=42&token=${TEST_SETUP_TOKEN}`)).status).toBe(401);
    expect((await fetch(`${base}/setup`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/setup/budget`, { method: "POST", body: "installation=42&windowUsd=1" })).status).toBe(
      401,
    );
    expect(app.db.getSetting(42, "budget.windowUsd").found).toBe(false);
  });

  it("renders escaped content with a strict CSP", async () => {
    const r = await fetch(`${base}/setup?installation=42`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);
    const html = await r.text();
    expect(html).not.toContain('<script>alert("acme")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;acme&quot;)&lt;/script&gt;");
    expect(html).toContain("Add a connection");
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("validates, saves encrypted, never shows the key again, and estimates cost per tier", async () => {
    const form = new URLSearchParams({
      installation: "42",
      provider: "anthropic",
      kind: "api-key",
      id: "main",
      label: "<b>x</b>",
      secret: KEY,
      intent: "save",
    });
    const r = await fetch(`${base}/setup/connections`, {
      method: "POST",
      headers: { ...auth, "x-setup-fragment": "1" },
      body: form,
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Saved connection");
    expect(html).not.toContain(KEY);
    expect(html).toContain("…XYZ9");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toMatch(/T3<\/td>/);
    expect(html).not.toContain("<b>x</b>");
    expect(app.db.loadConnections(42).connections[0]?.secret).toEqual({ kind: "api-key", apiKey: KEY });
    const page = await (await fetch(`${base}/setup?installation=42`, { headers: auth })).text();
    expect(page).not.toContain(KEY);
  });

  it("does not save a connection that fails validation and scrubs the key from the message", async () => {
    const form = new URLSearchParams({
      installation: "42",
      provider: "anthropic",
      kind: "api-key",
      id: "bad",
      secret: "sk-ant-wrongwrongwrong-0000",
      intent: "save",
    });
    const r = await fetch(`${base}/setup/connections`, { method: "POST", headers: auth, body: form });
    expect(r.status).toBe(422);
    const html = await r.text();
    expect(html).toContain("Validation failed");
    expect(html).not.toContain("sk-ant-wrongwrongwrong-0000");
    expect(app.db.listConnections(42)).toEqual([]);
  });

  it("validate-only does not save; remove deletes", async () => {
    const base42 = { installation: "42", provider: "anthropic", kind: "api-key", id: "main", secret: KEY };
    await fetch(`${base}/setup/connections`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ ...base42, intent: "test" }),
    });
    expect(app.db.listConnections(42)).toEqual([]);
    await fetch(`${base}/setup/connections`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ ...base42, intent: "save" }),
    });
    expect(app.db.listConnections(42)).toHaveLength(1);
    await fetch(`${base}/setup/connections/delete`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ installation: "42", id: "main" }),
    });
    expect(app.db.listConnections(42)).toEqual([]);
  });

  it("saves budget ceilings with null-vs-zero semantics", async () => {
    const body = new URLSearchParams({
      installation: "42",
      perChangeUsd: "",
      windowUsd: "0",
      spendLimitUsd: "100",
      perInstallationMonthlyUsd: "",
    });
    const r = await fetch(`${base}/setup/budget`, { method: "POST", headers: auth, body });
    expect(r.status).toBe(200);
    expect(app.db.getSetting(42, "budget.windowUsd").value).toBe(0);
    expect(app.db.getSetting(42, "budget.perChangeUsd").value).toBeNull();
    expect(app.db.getSetting(42, "budget.spendLimitUsd").value).toBe(100);
    const bad = await fetch(`${base}/setup/budget`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ installation: "42", windowUsd: "-5" }),
    });
    expect(bad.status).toBe(422);
    expect(app.db.getSetting(42, "budget.windowUsd").value).toBe(0);
  });

  it("rejects unknown installations", async () => {
    const r = await fetch(`${base}/setup/budget`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ installation: "999", windowUsd: "1" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("admin API", () => {
  beforeEach(() => app.db.upsertInstallation(42, "acme"));

  it("records a SHA-bound human verdict with provenance", async () => {
    const payload = {
      repo: "o/r",
      number: 7,
      headSha: HEAD_SHA,
      decision: "pass",
      reason: "reviewed by hand",
      signedBy: "alice",
    };
    expect(
      (await fetch(`${base}/installations/42/verdict`, { method: "POST", body: JSON.stringify(payload) })).status,
    ).toBe(401);
    const r = await fetch(`${base}/installations/42/verdict`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(201);
    expect(gate.humanVerdicts[0]).toMatchObject({
      headSha: HEAD_SHA,
      decision: "pass",
      reason: "reviewed by hand",
      signedBy: { kind: "human", login: "alice" },
    });
    expect(((await r.json()) as { verdict: { kind: string } }).verdict.kind).toBe("human");
    const bad = await fetch(`${base}/installations/42/verdict`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...payload, headSha: "abc" }),
    });
    expect(bad.status).toBe(400);
    expect(
      (await fetch(`${base}/installations/7/verdict`, { method: "POST", headers: auth, body: JSON.stringify(payload) }))
        .status,
    ).toBe(404);
  });

  it("explains a PR", async () => {
    expect((await fetch(`${base}/installations/42/prs/7?repo=o/r`)).status).toBe(401);
    const r = await fetch(`${base}/installations/42/prs/7?repo=o/r`, { headers: auth });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { verdict: { decision: string }; baseRef: string; history: unknown[] };
    expect(j.verdict.decision).toBe("pass");
    expect(j.baseRef).toBe("main");
    expect((await fetch(`${base}/installations/42/prs/7`, { headers: auth })).status).toBe(400);
  });
});

describe("health and metrics", () => {
  it("reports queue depth and Prometheus metrics", async () => {
    await app.worker.stop(0);
    await hook("pull_request", prPayload());
    const h = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; queue: { queued: number } };
    expect(h).toMatchObject({ ok: true, queue: { queued: 1 } });
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toContain('merge_safely_jobs{state="queued"} 1');
    expect(m).toContain("merge_safely_queue_depth 1");
    expect(m).toContain('merge_safely_spend_usd{installation="42"} 0');
    expect(m).toMatch(/merge_safely_webhooks_total\{event="pull_request",outcome="enqueued"\} 1/);
  });

  it("counts verdicts by decision and tier", async () => {
    const { queued } = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    await until(() => app.db.getJob(queued)?.state === "done");
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toContain('merge_safely_verdicts_total{decision="pass",tier="1"} 1');
  });
});

describe("graceful shutdown", () => {
  it("finishes a running job before closing", async () => {
    let finished = false;
    gate.review = async () => {
      await sleep(50);
      finished = true;
      const { fakeVerdict } = await import("./testing.js");
      return fakeVerdict();
    };
    const { queued } = (await (await hook("pull_request", prPayload())).json()) as { queued: number };
    await until(() => app.db.getJob(queued)?.state === "running");
    const db = app.db;
    const state = () => db.db.prepare("SELECT state FROM jobs WHERE id = ?").get(queued) as { state: string };
    let s = "";
    const origClose = db.close.bind(db);
    db.close = () => {
      s = state().state;
      origClose();
    };
    expect(await app.close(2000)).toBe(0);
    expect(finished).toBe(true);
    expect(s).toBe("done");
    await boot(); // afterEach closes it
  });
});
