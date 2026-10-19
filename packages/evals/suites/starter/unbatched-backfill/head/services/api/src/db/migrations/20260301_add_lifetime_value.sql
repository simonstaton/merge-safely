-- Adds the column the dashboard reads; populated by the backfill-user-stats-lifetime-value job.
ALTER TABLE user_stats ADD COLUMN lifetime_value_cents bigint NOT NULL DEFAULT 0;
