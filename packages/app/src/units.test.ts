import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type ModelInfo } from "@merge-safely/core";
import { sqliteStores } from "@merge-safely/store-sqlite";
import { describe, expect, it } from "vitest";
import { alertText, evaluateInstallation, startOfUtcMonth } from "./alerts.js";
import { AppDb } from "./db.js";
import { estimateTiers, pickEstimateModel } from "./estimate.js";
import { safeEqual } from "./http.js";
import { createLogger, SecretSet } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { fetchPolicy, policyFailureSummary } from "./run-job.js";
import { connectionFromForm, esc, parseBudgetForm, renderSetup } from "./setup.js";
import { fakeOctokit, TEST_MASTER_KEY } from "./testing.js";
import { pricing } from "./wiring.js";

const now = new Date("2026-10-19T12:00:00Z");

describe("esc", () => {
  it("escapes every HTML-significant character", () => {
    expect(esc(`<a href="x" onclick='y'>&\`</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;",
    );
    expect(esc(undefined)).toBe("");
  });

  it("is applied to everything renderSetup prints", () => {
    const evil = `"><script>x</script>`;
    const html = renderSetup({
      installations: [{ id: 1, account: evil }],
      installationId: 1,
      connections: [
        {
          record: { id: evil, provider: evil, kind: "api-key", createdAt: "x", label: evil, defaultModel: evil },
          hint: evil,
        },
      ],
      providers: [{ id: evil, kinds: ["api-key"], served: true, note: evil }],
      overrides: { perChangeUsd: null, windowUsd: 0, spendLimitUsd: null, perInstallationMonthlyUsd: null },
      flash: { ok: false, title: evil, lines: [evil] },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"><script');
  });
});

describe("safeEqual", () => {
  it("compares in constant time over hashes and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("logger", () => {
  it("scrubs registered secrets and token shapes from every line", () => {
    const secrets = new SecretSet();
    secrets.add("my-webhook-secret-value");
    const lines: string[] = [];
    const log = createLogger({ secrets, write: (l) => lines.push(l) }).child({ jobId: 1 });
    log.info("boom my-webhook-secret-value", { nested: { e: new Error("token ghs_abcdefghijklmnopqrstuvwxyz0123") } });
    log.debug("hidden");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("my-webhook-secret-value");
    expect(lines[0]).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz0123");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "info", jobId: 1 });
  });
});

describe("connectionFromForm", () => {
  it("builds each kind and normalises gateways", () => {
    const gw = connectionFromForm(
      { provider: "openrouter", kind: "auto", id: "or", secret: "sk-or-abcdefabcdef" },
      now,
    );
    expect(gw.ok && gw.conn).toMatchObject({
      provider: "openai-compatible",
      kind: "openai-compatible",
      label: "openrouter",
    });
    expect(gw.ok && gw.conn.secret).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1" });
    const hdr = connectionFromForm(
      {
        provider: "openai-compatible",
        kind: "openai-compatible",
        id: "gw",
        baseUrl: "https://gw.example.com/v1",
        headers: "X-Org: acme",
      },
      now,
    );
    expect(hdr.ok && hdr.conn.secret).toMatchObject({ headers: { "X-Org": "acme" } });
    const cli = connectionFromForm(
      { provider: "anthropic", kind: "api-key", id: "a", secret: "k".repeat(20), runner: "cli" },
      now,
    );
    expect(cli.ok && cli.conn.options).toEqual({ runner: "cli" });
  });

  it("rejects bad input with a useful message", () => {
    expect(connectionFromForm({ provider: "anthropic", kind: "api-key", id: "bad id" }, now)).toMatchObject({
      ok: false,
    });
    expect(connectionFromForm({ provider: "gemini", kind: "subscription", id: "g" }, now)).toMatchObject({ ok: false });
    expect(connectionFromForm({ provider: "anthropic", kind: "api-key", id: "a" }, now)).toMatchObject({ ok: false });
    expect(
      connectionFromForm(
        { provider: "openai-compatible", kind: "openai-compatible", id: "x", baseUrl: "ftp://x" },
        now,
      ),
    ).toMatchObject({ ok: false });
    expect(
      connectionFromForm(
        { provider: "openai-compatible", kind: "openai-compatible", id: "x", baseUrl: "https://x", headers: "nope" },
        now,
      ),
    ).toMatchObject({ ok: false });
  });

  it("parses the budget form", () => {
    expect(parseBudgetForm({ perChangeUsd: "0", windowUsd: "", spendLimitUsd: "1.5" })).toEqual({
      ok: true,
      value: { perChangeUsd: 0, windowUsd: null, spendLimitUsd: 1.5, perInstallationMonthlyUsd: null },
    });
    expect(parseBudgetForm({ windowUsd: "abc" }).ok).toBe(false);
  });
});

describe("estimate", () => {
  const model: ModelInfo = {
    provider: "anthropic",
    name: "m",
    tier: "mid",
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 1,
    maxOutputTokens: 1,
    pricing: { inPerMTok: 3, outPerMTok: 15 },
  };
  it("prices each default tier panel", () => {
    const t = estimateTiers(model);
    expect(t.map((x) => x.hunters)).toEqual([
      DEFAULT_POLICY.panel.t1.hunters.length,
      DEFAULT_POLICY.panel.t2.hunters.length,
      DEFAULT_POLICY.panel.t3.hunters.length,
    ]);
    expect(t[2]?.judges).toBe(4); // two judges, second judge round
    expect(t[0]?.usd).toBeCloseTo(2 * (0.18 + 0.06) + (0.135 + 0.045), 6);
    const [a, b, c] = t.map((x) => x.usd);
    expect((a ?? 0) < (b ?? 0) && (b ?? 0) < (c ?? 0)).toBe(true);
    expect(estimateTiers({ ...model, pricing: undefined, provider: "ollama", name: "llama" })[0]?.zeroCost).toBe(true);
  });
  it("picks the default model, else a mid tier", () => {
    const small = { ...model, name: "s", tier: "small" as const };
    expect(pickEstimateModel([small, model], "s")?.name).toBe("s");
    expect(pickEstimateModel([small, model])?.name).toBe("m");
  });
});

describe("fetchPolicy", () => {
  it("uses the default policy when the file is missing and reports YAML and schema errors", async () => {
    const o = fakeOctokit({ policies: { main: "budget: [", dev: "unknownTop: 1", ok: "triage:\n  maxLines: 10\n" } });
    expect(await fetchPolicy(o, "o", "r", "none")).toMatchObject({ ok: true, source: "default" });
    expect(await fetchPolicy(o, "o", "r", "main")).toMatchObject({ ok: false });
    expect(await fetchPolicy(o, "o", "r", "dev")).toMatchObject({ ok: false });
    const good = await fetchPolicy(o, "o", "r", "ok");
    expect(good.ok && good.policy.triage.maxLines).toBe(10);
    expect(policyFailureSummary(["a: bad"], "main")).toContain("base branch `main`");
  });
});

describe("pricing.cheaper", () => {
  it("never steps to a model the connection cannot reach", () => {
    const ref = { connectionId: "c", provider: "anthropic", name: "not-a-real-model" };
    expect(pricing.cheaper(ref, [])).toBeUndefined();
  });
});

describe("budget alerts", () => {
  it("fire once per crossing to Slack and re-arm only after dropping back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-app-alert-"));
    const db = new AppDb({ path: join(dir, "app.db"), masterKey: TEST_MASTER_KEY, now: () => now });
    const stores = sqliteStores({ path: join(dir, "app.db"), now: () => now });
    db.upsertInstallation(5, "acme");
    db.setSetting(5, "budget.spendLimitUsd", 10);
    const posts: string[] = [];
    const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
      posts.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const deps = {
      db,
      ledger: stores.ledger,
      logger: createLogger({ level: "error", write: () => {} }),
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/secret",
      fetch: fetchFake,
      now: () => now,
    };
    const entry = (usd: number) => ({
      at: now.toISOString(),
      repo: { host: "github.com", owner: "o", name: "r" },
      number: 1,
      headSha: "a".repeat(40),
      round: 1,
      seatId: "s",
      lens: "correctness",
      connectionId: "c",
      provider: "anthropic",
      model: "m",
      tokens: { in: 1, out: 1 },
      usd,
      estimated: false,
      installationId: "5",
    });
    await stores.ledger.append(entry(6));
    const first = await evaluateInstallation(deps, 5);
    expect(first.map((e) => [e.ceiling, e.threshold])).toEqual([["all-time", 0.5]]);
    expect(await evaluateInstallation(deps, 5)).toEqual([]); // latched
    await stores.ledger.append(entry(5));
    const more = await evaluateInstallation(deps, 5);
    expect(more.map((e) => e.threshold)).toEqual([0.8, 1]);
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatch(/refused at admission/);
    // Latch survives a "restart" (it lives in settings).
    expect(await evaluateInstallation(deps, 5)).toEqual([]);
    stores.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("formats alerts and month starts", () => {
    expect(alertText(1, { ceiling: "window", threshold: 0.8, fraction: 0.85 }, undefined)).toMatch(/crossed 80%/);
    expect(startOfUtcMonth(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("metrics registry", () => {
  it("renders Prometheus text with escaped labels", () => {
    const m = new MetricsRegistry();
    m.inc("x_total", "help", { a: 'q"\\' });
    m.inc("x_total", "help", { a: 'q"\\' });
    expect(m.render()).toContain('x_total{a="q\\"\\\\"} 2');
    expect(m.render()).toContain("# TYPE x_total counter");
  });
});

describe("defaultRegistry", () => {
  it("serves every shipped provider including the compatible and local presets", async () => {
    const { defaultRegistry } = await import("./wiring.js");
    const ids = defaultRegistry().ids();
    for (const id of [
      "anthropic",
      "openai",
      "gemini",
      "openai-compatible",
      "anthropic-compatible",
      "ollama",
      "lmstudio",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
