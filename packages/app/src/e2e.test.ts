/**
 * End to end through the REAL gate (core createGate): webhook -> durable queue -> run-job -> gate -> sqlite store,
 * with testkit's fake provider and workspace and a fake GitHub client. No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullFileData } from "@merge-safely/github";
import { createProviderRegistry } from "@merge-safely/providers";
import { fakeModel, fakeProvider, fakeWorkspace } from "@merge-safely/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp } from "./app.js";
import { createLogger } from "./logger.js";
import { fakeOctokit, HEAD_SHA, sign, TEST_WEBHOOK_SECRET, testConfig } from "./testing.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ms-app-e2e-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

function patchOf(lines: number, prefix = "line"): string {
  const body = Array.from({ length: lines }, (_, i) => `+${prefix} ${i}`).join("\n");
  return `@@ -0,0 +1,${lines} @@\n${body}`;
}

function diffOf(files: PullFileData[]): string {
  return files
    .map(
      (f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch ?? ""}`,
    )
    .join("\n");
}

async function run(files: PullFileData[]) {
  const provider = fakeProvider({
    id: "fake",
    connectionKinds: ["api-key"],
    models: [fakeModel({ name: "fake-model" })],
  });
  const octo = fakeOctokit({ baseRef: "main", files, diff: diffOf(files) });
  const app: App = createApp({
    config: testConfig(dir),
    logger: createLogger({ level: "error", write: () => {} }),
    octokitFor: () => octo,
    registry: createProviderRegistry([provider]),
    workspaceFactory: () => fakeWorkspace(),
    worker: { pollMs: 5, backoffBaseMs: 1 },
  });
  app.db.upsertInstallation(42, "acme");
  app.db.saveConnection(42, {
    id: "fake-main",
    provider: "fake",
    kind: "api-key",
    createdAt: "2026-10-19T00:00:00.000Z",
    defaultModel: "fake-model",
    secret: { kind: "api-key", apiKey: "fake-key-0123456789" },
  });
  await app.start();
  const port = await app.listen(0, "127.0.0.1");
  const body = JSON.stringify({
    action: "opened",
    number: 7,
    installation: { id: 42, account: { login: "acme" } },
    repository: { name: "r", owner: { login: "o" }, html_url: "https://github.com/o/r" },
    pull_request: { number: 7, draft: false, head: { sha: HEAD_SHA }, base: { ref: "main" } },
  });
  const r = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": sign(TEST_WEBHOOK_SECRET, body),
    },
    body,
  });
  const { queued } = (await r.json()) as { queued: number };
  await until(() => ["done", "failed"].includes(app.db.getJob(queued)?.state ?? ""));
  const job = app.db.getJob(queued);
  const stored = await app.stores.verdicts.get({
    repo: { host: "github.com", owner: "o", name: "r" },
    number: 7,
    headSha: HEAD_SHA,
  });
  const checkCalls = octo.calls.filter((c) => c.method === "checks.create" || c.method === "checks.update");
  await app.close(2000);
  return { job, verdict: stored?.verdict, provider, checkCalls };
}

describe("App through the real gate", () => {
  it("auto-passes a docs-only PR at triage with no model call", async () => {
    const files: PullFileData[] = [
      { filename: "docs/guide.md", status: "modified", additions: 3, deletions: 1, patch: patchOf(3, "doc") },
    ];
    const { job, verdict, provider, checkCalls } = await run(files);
    expect(job?.error ?? null).toBeNull();
    expect(job).toMatchObject({ state: "done", outcome: "pass", base_ref: "main", policy_source: "default" });
    expect(verdict).toMatchObject({ decision: "pass", triaged: true, headSha: HEAD_SHA });
    expect(provider.calls).toHaveLength(0);
    expect(checkCalls.length).toBeGreaterThan(0);
  });

  it("runs a tier-1 panel on the installation's connection and passes", async () => {
    // ~200 changed lines across 8 files in 3 modules: tier 1 under the default thresholds.
    const dirs = ["src/orders", "src/billingless", "lib/util"];
    const files: PullFileData[] = Array.from({ length: 8 }, (_, i) => ({
      filename: `${dirs[i % 3]}/file${i}.ts`,
      status: "modified",
      additions: 25,
      deletions: 0,
      patch: patchOf(25, `const v${i} =`),
    }));
    const { job, verdict, provider } = await run(files);
    expect(job?.error ?? null).toBeNull();
    expect(job).toMatchObject({ state: "done", outcome: "pass" });
    expect(verdict?.decision).toBe("pass");
    expect(verdict?.triaged).toBe(false);
    expect(verdict?.tier.level).toBe(1);
    // Tier 1 seats the correctness and repro hunters; with no candidate findings there is nothing to judge.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(verdict?.seats.map((s) => s.seat.lens).sort()).toEqual(expect.arrayContaining(["correctness", "repro"]));
    expect(verdict?.seats.every((s) => s.seat.model.connectionId === "fake-main")).toBe(true);
  });
});
