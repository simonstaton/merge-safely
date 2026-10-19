/**
 * Composition root: database, stores, worker, HTTP routes. `main.ts` calls this with the real config; tests call it
 * with fakes (octokit, gate factory, provider registry) and an ephemeral data directory.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ToolExecutorFactory, Workspace } from "@merge-safely/core";
import type { FetchLike } from "@merge-safely/escalation-slack";
import type { ProviderRegistry } from "@merge-safely/providers";
import { type SqliteStores, sqliteStores } from "@merge-safely/store-sqlite";
import type { LocalWorkspaceOptions } from "@merge-safely/workspace-local";
import { evaluateInstallation } from "./alerts.js";
import { apiHandler } from "./api.js";
import { CatalogCache } from "./catalog-cache.js";
import { type AppConfig, configSecrets } from "./config.js";
import { AppDb } from "./db.js";
import { defaultGateFactory, type GateFactory } from "./gate.js";
import { installationClient, listAppInstallations } from "./github-client.js";
import { send, sendJson } from "./http.js";
import { type AppLogger, createLogger, errText, SecretSet } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { Worker, type WorkerOptions } from "./queue.js";
import {
  type AppOctokit,
  failureCheckRun,
  type PipelineDeps,
  prepare,
  purgeInstallationFiles,
  runJob,
  splitRepo,
} from "./run-job.js";
import { loadBudgetOverrides } from "./settings.js";
import { setupHandler } from "./setup.js";
import { webhookHandler } from "./webhooks.js";
import { defaultRegistry } from "./wiring.js";

export interface CreateAppOptions {
  config: AppConfig;
  logger?: AppLogger;
  secrets?: SecretSet;
  octokitFor?: (installationId: number) => AppOctokit;
  /**
   * Boot-time sync of the App's installations from GitHub (so installs made before this service first ran appear).
   * Default: on with the real client, off when `octokitFor` is injected. `false` disables it.
   */
  syncInstallations?: false | (() => Promise<{ id: number; account: string }[]>);
  gateFactory?: GateFactory;
  registry?: ProviderRegistry;
  workspaceFactory?: (opts: LocalWorkspaceOptions) => Workspace;
  tools?: ToolExecutorFactory;
  fetch?: FetchLike;
  now?: () => Date;
  worker?: Partial<Pick<WorkerOptions, "pollMs" | "backoffBaseMs" | "maxRetries" | "tickMs">>;
}

export interface App {
  server: Server;
  worker: Worker;
  db: AppDb;
  stores: SqliteStores;
  metrics: MetricsRegistry;
  logger: AppLogger;
  /** Start the worker loop (re-queues interrupted jobs first). Does not listen. */
  start(): Promise<void>;
  listen(port: number, host?: string): Promise<number>;
  /** Graceful shutdown: stop accepting, finish running jobs up to the deadline, close the databases. */
  close(deadlineMs?: number): Promise<number>;
}

function githubHost(apiUrl: string | undefined): string {
  if (!apiUrl) return "github.com";
  try {
    return new URL(apiUrl).host;
  } catch (_err: unknown) {
    return "github.com";
  }
}

export function createApp(opts: CreateAppOptions): App {
  const { config } = opts;
  const secrets = opts.secrets ?? new SecretSet();
  secrets.addLongLived(...configSecrets(config));
  const logger = opts.logger ?? createLogger({ level: config.logLevel, secrets });
  const now = opts.now ?? (() => new Date());
  const db = new AppDb({ path: config.dbPath, masterKey: config.masterKey, now });
  const stores = sqliteStores({ path: config.dbPath, now });
  const metrics = new MetricsRegistry();
  const registry = opts.registry ?? defaultRegistry();
  const catalogCache = new CatalogCache(registry);

  const clientOpts = {
    appId: config.appId,
    privateKey: config.privateKey,
    logger,
    ...(config.githubApiUrl ? { baseUrl: config.githubApiUrl } : {}),
  };
  const octokitFor = opts.octokitFor ?? ((installationId: number) => installationClient(clientOpts, installationId));
  const syncInstallations =
    opts.syncInstallations === false
      ? undefined
      : (opts.syncInstallations ?? (opts.octokitFor ? undefined : () => listAppInstallations(clientOpts)));

  const pipeline: PipelineDeps = {
    config: {
      dataDir: config.dataDir,
      githubHost: githubHost(config.githubApiUrl),
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      ...(config.slackWebhookUrl ? { slackWebhookUrl: config.slackWebhookUrl } : {}),
    },
    db,
    store: stores.verdicts,
    ledger: stores.ledger,
    octokitFor,
    gateFactory: opts.gateFactory ?? defaultGateFactory,
    registry,
    catalogCache,
    secrets,
    logger,
    metrics,
    ...(opts.workspaceFactory ? { workspaceFactory: opts.workspaceFactory } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  };

  const alertDeps = {
    db,
    ledger: stores.ledger,
    logger,
    now,
    ...(config.slackWebhookUrl ? { slackWebhookUrl: config.slackWebhookUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };

  let lastCompact = 0;
  const worker = new Worker({
    db,
    run: (job) => runJob(pipeline, job),
    logger,
    secrets,
    metrics,
    concurrency: config.concurrency,
    ...opts.worker,
    afterJob: async (job) => {
      await evaluateInstallation(alertDeps, job.installation_id);
    },
    onFinalFailure: async (job, message) => {
      if (!job.head_sha) return;
      const { owner, name } = splitRepo(job.repo);
      await failureCheckRun(
        octokitFor(job.installation_id),
        owner,
        name,
        job.head_sha,
        "Merge Safely could not complete the review",
        `The review job failed after ${job.attempts} attempt(s):\n\n${message}\n\nRe-run this check once the cause is fixed.`,
      );
    },
    onTick: async () => {
      for (const inst of db.listInstallations()) await evaluateInstallation(alertDeps, inst.id);
      if (Date.now() - lastCompact > 24 * 60 * 60 * 1000) {
        lastCompact = Date.now();
        const { compacted } = stores.compact();
        if (compacted > 0) logger.info("compacted cost ledger", { rows: compacted });
      }
    },
  });

  const webhookDeps = {
    db,
    webhookSecret: config.webhookSecret,
    logger,
    metrics,
    wake: () => worker.pump(),
    onIntake: (id: number) => evaluateInstallation(alertDeps, id),
    onUninstall: (id: number) => {
      catalogCache.invalidate(id);
      void purgeInstallationFiles(config.dataDir, id, logger);
    },
    onReposRemoved: (id: number, repos: string[]) => {
      void purgeInstallationFiles(config.dataDir, id, logger, repos);
    },
  };
  const setupDeps = {
    db,
    registry,
    ledger: stores.ledger,
    catalogCache,
    setupToken: config.setupToken,
    logger,
    secrets,
    now,
  };
  const apiDeps = {
    db,
    setupToken: config.setupToken,
    logger,
    secrets,
    prepare: (i: number, r: string, n: number, sha?: string) => prepare(pipeline, i, r, n, sha, { light: true }),
  };

  async function renderMetrics(): Promise<string> {
    const counts = db.countByState();
    metrics.clear("merge_safely_jobs");
    for (const [state, n] of Object.entries(counts)) {
      metrics.set("merge_safely_jobs", "Jobs in the durable queue, by state", { state }, n);
    }
    metrics.set("merge_safely_queue_depth", "Jobs queued or running", {}, counts.queued + counts.running);
    metrics.clear("merge_safely_spend_usd");
    for (const inst of db.listInstallations()) {
      try {
        const s = await stores.ledger.allTime(String(inst.id));
        metrics.set(
          "merge_safely_spend_usd",
          "All-time spend per installation (this gate's ledger)",
          { installation: String(inst.id) },
          s.usd,
        );
      } catch (err: unknown) {
        logger.warn("metrics: could not read spend", { installationId: inst.id, error: errText(err) });
      }
    }
    return metrics.render();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/webhooks/github") {
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      return webhookHandler(webhookDeps, req, res);
    }
    if (path === "/healthz") {
      const c = db.countByState();
      return sendJson(res, 200, {
        ok: true,
        queue: { queued: c.queued, running: c.running },
        inFlight: worker.inFlight(),
      });
    }
    if (path === "/metrics") return send(res, 200, await renderMetrics(), "text/plain; version=0.0.4; charset=utf-8");
    if (path === "/setup" || path.startsWith("/setup/")) return setupHandler(setupDeps, req, res, url);
    if (await apiHandler(apiDeps, req, res, url)) return;
    req.resume();
    send(res, 404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      logger.error("unhandled request error", { error: errText(err) });
      if (!res.headersSent) send(res, 500, "internal error");
      else res.end();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  let closed = false;
  return {
    server,
    worker,
    db,
    stores,
    metrics,
    logger,
    async start() {
      if (syncInstallations) {
        try {
          const found = await syncInstallations();
          let added = 0;
          for (const i of found) if (db.addInstallationIfUnknown(i.id, i.account)) added++;
          logger.info("synced installations from GitHub", { found: found.length, added });
        } catch (err: unknown) {
          logger.warn("could not list the App's installations; relying on installation webhooks", {
            error: errText(err),
          });
        }
      }
      // Survives restarts: validate persisted ceilings up front (bad values are logged, not fatal).
      for (const inst of db.listInstallations()) loadBudgetOverrides(db, inst.id, logger);
      worker.start();
    },
    listen(port, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    async close(deadlineMs = 30_000) {
      if (closed) return 0;
      closed = true;
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      const left = await worker.stop(deadlineMs);
      server.closeAllConnections?.();
      await serverClosed;
      stores.close();
      db.close();
      return left;
    },
  };
}
