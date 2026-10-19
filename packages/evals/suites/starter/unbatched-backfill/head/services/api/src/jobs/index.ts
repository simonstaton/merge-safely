import { backfillUserStatsJob } from "./backfillUserStats.js";
import { cleanupSessionsJob } from "./cleanupSessions.js";
import type { Job } from "./types.js";

export const jobs: Job[] = [cleanupSessionsJob, backfillUserStatsJob];
