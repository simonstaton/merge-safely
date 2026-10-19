import { pool, sleep } from "../db/client.js";
import type { Job } from "./types.js";

const BATCH = 1000;

/** Deletes expired sessions in small batches so the sessions table is never locked for long. */
export const cleanupSessionsJob: Job = {
  name: "cleanup-sessions",
  schedule: "*/15 * * * *",
  async run(log) {
    let total = 0;
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM sessions
          WHERE id IN (SELECT id FROM sessions WHERE expires_at < now() ORDER BY id LIMIT $1)`,
        [BATCH],
      );
      total += rowCount ?? 0;
      if (!rowCount || rowCount < BATCH) break;
      await sleep(200);
    }
    log.info("expired sessions removed", { total });
  },
};
