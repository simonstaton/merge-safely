/**
 * Service configuration from the environment. Validated once at boot; a bad value refuses to start with a message
 * that names the variable and the fix (and never echoes a secret value).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  masterKey: string;
  dataDir: string;
  /** SQLite file for the App's own tables and the verdict store / cost ledger. */
  dbPath: string;
  port: number;
  publicUrl?: string;
  setupToken: string;
  slackWebhookUrl?: string;
  concurrency: number;
  logLevel: LogLevel;
  /** GitHub Enterprise Server API root; unset for github.com. */
  githubApiUrl?: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export const MASTER_KEY_HELP =
  "MERGE_SAFELY_MASTER_KEY is required: it encrypts every stored provider secret. Generate one with\n" +
  "    openssl rand -hex 32\n" +
  "or\n" +
  "    node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n" +
  "and keep it outside the data volume and its backups. Losing it means re-connecting every provider.";

export const SETUP_TOKEN_HELP =
  "SETUP_TOKEN is required: it is the bearer token that protects /setup and the admin endpoints. Generate one with\n" +
  "    openssl rand -hex 24";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const httpUrl = (name: string) =>
  optionalString.refine((v) => v === undefined || /^https?:\/\/[^\s]+$/i.test(v), `${name} must be an http(s) URL`);

const envSchema = z.object({
  GITHUB_APP_ID: z
    .string({ required_error: "GITHUB_APP_ID is required (the App's numeric id)" })
    .regex(/^\d+$/, "GITHUB_APP_ID must be the App's numeric id"),
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_PRIVATE_KEY_FILE: optionalString,
  GITHUB_WEBHOOK_SECRET: z
    .string({ required_error: "GITHUB_WEBHOOK_SECRET is required (the webhook secret set on the App)" })
    .min(16, "GITHUB_WEBHOOK_SECRET must be at least 16 characters"),
  MERGE_SAFELY_MASTER_KEY: z.string({ required_error: MASTER_KEY_HELP }).min(12, MASTER_KEY_HELP),
  MERGE_SAFELY_DATA_DIR: optionalString,
  /** Optional explicit database file (defaults to $MERGE_SAFELY_DATA_DIR/app.db). */
  DATABASE: optionalString,
  PORT: optionalString.refine(
    (v) => v === undefined || (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536),
    "PORT must be an integer between 1 and 65535",
  ),
  PUBLIC_URL: httpUrl("PUBLIC_URL"),
  SETUP_TOKEN: z.string({ required_error: SETUP_TOKEN_HELP }).min(16, SETUP_TOKEN_HELP),
  SLACK_WEBHOOK_URL: optionalString.refine(
    (v) => v === undefined || v.startsWith("https://"),
    "SLACK_WEBHOOK_URL must be an https:// Slack incoming webhook URL",
  ),
  CONCURRENCY: optionalString.refine(
    (v) => v === undefined || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 32),
    "CONCURRENCY must be an integer between 1 and 32",
  ),
  LOG_LEVEL: optionalString.refine(
    (v) => v === undefined || ["debug", "info", "warn", "error"].includes(v.toLowerCase()),
    "LOG_LEVEL must be one of debug, info, warn, error",
  ),
  GITHUB_API_URL: httpUrl("GITHUB_API_URL"),
});

export type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  readFile?: (path: string) => string;
}

/** Normalise a PEM given inline in an env file, where newlines are often written as literal `\n`. */
export function normalisePem(pem: string): string {
  const s = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  return `${s.trim()}\n`;
}

export function loadConfig(env: Env, opts: LoadConfigOptions = {}): AppConfig {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const parsed = envSchema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(issue.message);
  }

  let privateKey: string | undefined;
  const inlineKey = env.GITHUB_APP_PRIVATE_KEY?.trim() ? env.GITHUB_APP_PRIVATE_KEY : undefined;
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() ? env.GITHUB_APP_PRIVATE_KEY_FILE : undefined;
  if (inlineKey && keyFile) {
    problems.push("set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE, not both");
  } else if (inlineKey) {
    privateKey = normalisePem(inlineKey);
  } else if (keyFile) {
    try {
      privateKey = normalisePem(readFile(keyFile));
    } catch (_err: unknown) {
      problems.push(`GITHUB_APP_PRIVATE_KEY_FILE could not be read (${keyFile})`);
    }
  } else {
    problems.push(
      "GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_FILE (path to the .pem) is required",
    );
  }
  if (privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    problems.push("the GitHub App private key is not a PEM private key (expected -----BEGIN ... PRIVATE KEY-----)");
  }

  if (problems.length > 0 || !parsed.success || !privateKey) throw new ConfigError(problems);
  const e = parsed.data;
  const dataDir = resolve(e.MERGE_SAFELY_DATA_DIR ?? "/data");
  const cfg: AppConfig = {
    appId: e.GITHUB_APP_ID,
    privateKey,
    webhookSecret: e.GITHUB_WEBHOOK_SECRET,
    masterKey: e.MERGE_SAFELY_MASTER_KEY,
    dataDir,
    dbPath: e.DATABASE ? resolve(e.DATABASE) : join(dataDir, "app.db"),
    port: e.PORT ? Number(e.PORT) : 8080,
    setupToken: e.SETUP_TOKEN,
    concurrency: e.CONCURRENCY ? Number(e.CONCURRENCY) : 2,
    logLevel: (e.LOG_LEVEL?.toLowerCase() as LogLevel | undefined) ?? "info",
  };
  if (e.PUBLIC_URL) cfg.publicUrl = e.PUBLIC_URL.replace(/\/+$/, "");
  if (e.SLACK_WEBHOOK_URL) cfg.slackWebhookUrl = e.SLACK_WEBHOOK_URL;
  if (e.GITHUB_API_URL) cfg.githubApiUrl = e.GITHUB_API_URL.replace(/\/+$/, "");
  return cfg;
}

/** Every secret value in the config, for the log scrubber. */
export function configSecrets(cfg: AppConfig): string[] {
  const out = [cfg.webhookSecret, cfg.masterKey, cfg.setupToken, cfg.privateKey, cfg.privateKey.trim()];
  if (cfg.slackWebhookUrl) out.push(cfg.slackWebhookUrl);
  return out;
}
