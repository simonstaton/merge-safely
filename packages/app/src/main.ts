#!/usr/bin/env node
/**
 * `merge-safely-app`: the self-hosted GitHub App service.
 * Reads configuration from the environment, starts the worker and the HTTP server, and shuts down gracefully on
 * SIGTERM/SIGINT (running jobs get up to SHUTDOWN_DEADLINE_MS, default 25 s, to finish; the rest resume at next boot).
 */
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger, errText, SecretSet } from "./logger.js";

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      process.stderr.write(`merge-safely-app: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const secrets = new SecretSet();
  const logger = createLogger({ level: config.logLevel, secrets });
  const app = createApp({ config, logger, secrets });
  app.start();
  const port = await app.listen(config.port);
  logger.info("merge-safely-app listening", { port, dataDir: config.dataDir, concurrency: config.concurrency });

  const deadline = Number(process.env.SHUTDOWN_DEADLINE_MS ?? "25000");
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    app
      .close(Number.isFinite(deadline) && deadline >= 0 ? deadline : 25_000)
      .then((left) => {
        logger.info("shutdown complete", { unfinishedJobs: left });
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error("shutdown failed", { error: errText(err) });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(`merge-safely-app: fatal: ${errText(err)}\n`);
  process.exit(1);
});
