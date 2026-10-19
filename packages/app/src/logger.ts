/**
 * Structured JSON-lines logging with secret scrubbing. Every line is serialised first and then scrubbed as a whole,
 * so a secret cannot slip through in a nested meta field or an error message.
 */
import type { Logger } from "@merge-safely/core";
import { redactSecrets } from "@merge-safely/github";
import { scrubText } from "@merge-safely/providers";
import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A growing set of secret values (config secrets, decrypted connection secrets, installation tokens). */
export class SecretSet {
  private readonly values = new Set<string>();

  add(...secrets: (string | undefined)[]): void {
    for (const s of secrets) if (s && s.length >= 6) this.values.add(s);
  }

  list(): string[] {
    return [...this.values];
  }

  scrub(text: string): string {
    return redactSecrets(scrubText(text, this.list()));
  }
}

export interface AppLogger extends Logger {
  child(bindings: Record<string, unknown>): AppLogger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  secrets?: SecretSet;
  write?: (line: string) => void;
  now?: () => Date;
  bindings?: Record<string, unknown>;
}

function errorMeta(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

export function createLogger(opts: CreateLoggerOptions = {}): AppLogger {
  const min = RANK[opts.level ?? "info"];
  const secrets = opts.secrets ?? new SecretSet();
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  const bindings = opts.bindings ?? {};

  const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (RANK[level] < min) return;
    const record: Record<string, unknown> = { ts: now().toISOString(), level, msg, ...bindings };
    for (const [k, v] of Object.entries(meta ?? {})) record[k] = errorMeta(v);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (_err: unknown) {
      line = JSON.stringify({ ts: record.ts, level, msg, note: "unserialisable meta dropped" });
    }
    write(secrets.scrub(line));
  };

  return {
    debug: (m, meta) => log("debug", m, meta),
    info: (m, meta) => log("info", m, meta),
    warn: (m, meta) => log("warn", m, meta),
    error: (m, meta) => log("error", m, meta),
    child: (b) => createLogger({ ...opts, secrets, write, now, bindings: { ...bindings, ...b } }),
  };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
