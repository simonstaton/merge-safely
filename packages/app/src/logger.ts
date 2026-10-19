/**
 * Structured JSON-lines logging with secret scrubbing. Every line is serialised first and then scrubbed as a whole,
 * so a secret cannot slip through in a nested meta field or an error message.
 */
import type { Logger } from "@merge-safely/core";
import { redactSecrets } from "@merge-safely/github";
import { scrubText } from "@merge-safely/providers";
import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-escaped form of a secret, as it appears inside a serialised log line. */
function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

export const SECRET_LRU_CAPACITY = 200;

/**
 * Secret values to scrub from every log line.
 * - `addLongLived`: config secrets (webhook secret, App private key, master key, setup token, Slack URL). Never evicted.
 * - `add`: short-lived or per-connection literals (installation tokens, connection keys, keys typed on the setup
 *   page). Kept in a bounded LRU so the set (and the per-line scrub cost) cannot grow for the life of the process;
 *   token shapes such as `ghs_…` are caught by pattern anyway.
 * Both raw and JSON-escaped variants are matched, because scrubbing runs on the serialised line.
 */
export class SecretSet {
  private readonly longLived = new Set<string>();
  private readonly recent = new Map<string, true>();

  constructor(private readonly capacity = SECRET_LRU_CAPACITY) {}

  addLongLived(...secrets: (string | undefined)[]): void {
    for (const s of secrets) if (s && s.length >= 6) this.longLived.add(s);
  }

  add(...secrets: (string | undefined)[]): void {
    for (const s of secrets) {
      if (!s || s.length < 6 || this.longLived.has(s)) continue;
      this.recent.delete(s);
      this.recent.set(s, true);
      while (this.recent.size > this.capacity) {
        const oldest = this.recent.keys().next().value;
        if (oldest === undefined) break;
        this.recent.delete(oldest);
      }
    }
  }

  remove(...secrets: string[]): void {
    for (const s of secrets) this.recent.delete(s);
  }

  size(): number {
    return this.longLived.size + this.recent.size;
  }

  list(): string[] {
    const out = new Set<string>();
    for (const s of [...this.longLived, ...this.recent.keys()]) {
      out.add(s);
      const e = jsonEscaped(s);
      if (e !== s) out.add(e);
    }
    return [...out];
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
