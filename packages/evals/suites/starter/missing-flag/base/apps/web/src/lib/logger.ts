import * as Sentry from "@sentry/react";

export const logger = {
  error(message: string, extra?: Record<string, unknown>): void {
    Sentry.captureMessage(message, { level: "error", extra });
  },
};
