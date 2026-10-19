import { withTransaction } from "../db/client.js";
import type { Job } from "./types.js";

/**
 * One-off: populate user_stats.lifetime_value_cents from the full order history.
 * Run once from the admin console after the migration ships.
 */
export const backfillUserStatsJob: Job = {
  name: "backfill-user-stats-lifetime-value",
  async run(log) {
    const updated = await withTransaction(async (tx) => {
      const { rowCount } = await tx.query(`
        UPDATE user_stats us
           SET lifetime_value_cents = totals.sum_cents,
               updated_at = now()
          FROM (
            SELECT user_id, SUM(amount_cents) AS sum_cents
              FROM orders
             WHERE status = 'paid'
             GROUP BY user_id
          ) totals
         WHERE us.user_id = totals.user_id
      `);
      return rowCount ?? 0;
    });
    log.info("lifetime value backfilled", { updated });
  },
};
