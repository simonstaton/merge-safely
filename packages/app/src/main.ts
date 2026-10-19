#!/usr/bin/env node
/**
 * `merge-safely-app`: the self-hosted GitHub App service.
 *
 *   merge-safely-app              start the service (config from the environment)
 *   merge-safely-app rotate-key   re-encrypt every stored connection from MERGE_SAFELY_MASTER_KEY_OLD to
 *                                 MERGE_SAFELY_MASTER_KEY (stop the service first)
 *
 * SIGTERM/SIGINT shut down gracefully: running jobs get SHUTDOWN_DEADLINE_MS (default 25 s) to finish; the rest
 * resume at next boot.
 */
import { join, resolve } from "node:path";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, MASTER_KEY_HELP } from "./config.js";
import { AppDb } from "./db.js";
import { createLogger, errText, SecretSet } from "./logger.js";

function fail(message: string, code = 2): never {
  process.stderr.write(`merge-safely-app: ${message}\n`);
  process.exit(code);
}

/** Exported for tests: returns the process exit code. */
export function rotateKey(env: Record<string, string | undefined>, out: (line: string) => void): number {
  const next = env.MERGE_SAFELY_MASTER_KEY?.trim();
  const old = env.MERGE_SAFELY_MASTER_KEY_OLD?.trim();
  if (!next) {
    out(`MERGE_SAFELY_MASTER_KEY (the NEW key) is required.\n${MASTER_KEY_HELP}`);
    return 2;
  }
  if (!old) {
    out("MERGE_SAFELY_MASTER_KEY_OLD (the key the database is encrypted with now) is required.");
    return 2;
  }
  if (old === next) {
    out("the old and new master keys are identical; nothing to do.");
    return 2;
  }
  const dataDir = resolve(env.MERGE_SAFELY_DATA_DIR?.trim() || "/data");
  const path = env.DATABASE?.trim() ? resolve(env.DATABASE.trim()) : join(dataDir, "app.db");
  let db: AppDb;
  try {
    db = new AppDb({ path, masterKey: next });
  } catch (err: unknown) {
    out(`could not open ${path}: ${errText(err)}`);
    return 1;
  }
  try {
    const r = db.rotateMasterKey(old);
    out(
      `re-encrypted ${r.rotated} connection(s); ${r.alreadyCurrent} already under the new key; ${r.failed.length} failed.`,
    );
    for (const f of r.failed)
      out(`  could not decrypt installation ${f.installationId} connection ${f.id} with either key; re-connect it`);
    return r.failed.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

async function serve(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
  const secrets = new SecretSet();
  const logger = createLogger({ level: config.logLevel, secrets });
  const app = createApp({ config, logger, secrets });
  await app.start();
  const port = await app.listen(config.port);
  logger.info("merge-safely-app listening", { port, dataDir: config.dataDir, concurrency: config.concurrency });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, deadlineMs: config.shutdownDeadlineMs });
    app
      .close(config.shutdownDeadlineMs)
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

const isMain = process.argv[1] !== undefined && /merge-safely-app$|main\.js$/.test(process.argv[1]);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "rotate-key") {
    process.exit(rotateKey(process.env, (l) => process.stdout.write(`${l}\n`)));
  } else if (cmd !== undefined && cmd !== "serve") {
    fail(`unknown command "${cmd}" (expected: serve, rotate-key)`);
  } else {
    serve().catch((err: unknown) => fail(`fatal: ${errText(err)}`, 1));
  }
}
