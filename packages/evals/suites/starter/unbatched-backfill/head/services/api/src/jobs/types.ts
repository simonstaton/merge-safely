export interface JobLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export interface Job {
  name: string;
  /** cron expression; omit for one-off jobs triggered from the admin console */
  schedule?: string;
  run(log: JobLogger): Promise<void>;
}
