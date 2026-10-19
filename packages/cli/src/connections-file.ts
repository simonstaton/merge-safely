/**
 * Raw access to the connections file for `connect` and `connections list|remove|test`.
 *
 * Editing goes through the raw JSON entries rather than load-then-save, so entries the CLI does not touch keep
 * their exact secret form (env reference, file reference or encrypted blob) and a missing master key never forces
 * a decrypt. Writes are validated against the providers' schema and land atomically with mode 0600.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Connection } from "@merge-safely/core";
import {
  type ConnectionFileEntry,
  type ConnectionsFile,
  connectionFileEntrySchema,
  connectionsFileSchema,
  encryptSecret,
  MASTER_KEY_ENV,
  maskSecret,
} from "@merge-safely/providers";
import { CliError } from "./errors.js";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export interface RawConnectionsFile {
  version: 1;
  /** Entries as stored. Unknown/invalid entries are kept as-is so a write never drops them. */
  connections: Record<string, unknown>[];
}

/** Read the file; a missing file is an empty one. Invalid JSON is an error (never silently overwritten). */
export async function readRawConnections(path: string): Promise<{ file: RawConnectionsFile; missing: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isRecord(err) && err.code === "ENOENT") return { file: { version: 1, connections: [] }, missing: true };
    throw new CliError("CONNECTIONS_UNREADABLE", `could not read connections file ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (_err: unknown) {
    throw new CliError("CONNECTIONS_INVALID", `connections file ${path} is not valid JSON; fix or move it first`);
  }
  if (!isRecord(json) || !Array.isArray(json.connections)) {
    throw new CliError("CONNECTIONS_INVALID", `connections file ${path} has no "connections" array`);
  }
  const entries = json.connections.filter(isRecord);
  return { file: { version: 1, connections: entries }, missing: false };
}

/** Write atomically, mode 0600, directory created 0700. Refuses to write a file the schema rejects. */
export async function writeRawConnections(path: string, file: RawConnectionsFile): Promise<void> {
  const checked = connectionsFileSchema.safeParse(file);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CliError("CONNECTIONS_INVALID", `refusing to write an invalid connections file (${issues})`);
  }
  let target = resolve(path);
  try {
    if ((await lstat(target)).isSymbolicLink()) target = await realpath(target);
  } catch (_err: unknown) {
    // does not exist yet
  }
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.connections.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  } catch (err: unknown) {
    await unlink(tmp).catch(() => undefined);
    const code = isRecord(err) && typeof err.code === "string" ? ` (${err.code})` : "";
    throw new CliError("CONNECTIONS_WRITE_FAILED", `could not write connections file ${path}${code}`);
  }
  await chmod(target, 0o600);
}

export interface EntryOptions {
  /** Encrypt the secret with this master key. */
  masterKey?: string;
  /** Store only this environment variable name instead of the secret. */
  envRef?: string;
}

/**
 * The file entry for a new connection: encrypted when a master key is given, an env reference when `envRef`
 * is given, else plaintext (with a warning returned). Cloud/subscription secrets are references, never secret.
 */
export function toFileEntry(conn: Connection, opts: EntryOptions): { entry: ConnectionFileEntry; warnings: string[] } {
  const { secret, ...record } = conn;
  const warnings: string[] = [];
  if (opts.masterKey) {
    return { entry: { ...record, secretRef: { encrypted: encryptSecret(secret, opts.masterKey, conn.id) } }, warnings };
  }
  if (secret.kind === "cloud" || secret.kind === "subscription") return { entry: { ...record, secret }, warnings };
  if (opts.envRef) {
    if (secret.kind === "openai-compatible" || secret.kind === "anthropic-compatible") {
      return {
        entry: {
          ...record,
          baseUrl: secret.baseUrl,
          ...(secret.headers ? { headers: secret.headers } : {}),
          secretRef: { env: opts.envRef },
        },
        warnings,
      };
    }
    return { entry: { ...record, secretRef: { env: opts.envRef } }, warnings };
  }
  if (secret.kind === "openai-compatible" && !secret.apiKey && !secret.headers) {
    // Keyless local endpoint: only a base URL, nothing secret.
    return { entry: { ...record, baseUrl: secret.baseUrl }, warnings };
  }
  warnings.push(
    `connection ${conn.id}: secret stored in plaintext (file mode 0600); set ${MASTER_KEY_ENV} to encrypt it, or use --api-key-env`,
  );
  return { entry: { ...record, secret }, warnings };
}

/** Insert or replace by id, keeping file order. Returns whether an entry was replaced. */
export function upsertEntry(file: RawConnectionsFile, entry: ConnectionFileEntry): boolean {
  const i = file.connections.findIndex((c) => c.id === entry.id);
  const raw = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  if (i >= 0) {
    file.connections[i] = raw;
    return true;
  }
  file.connections.push(raw);
  return false;
}

export function removeEntry(file: RawConnectionsFile, id: string): boolean {
  const before = file.connections.length;
  file.connections = file.connections.filter((c) => c.id !== id);
  return file.connections.length !== before;
}

export interface ListedConnection {
  id: string;
  provider: string;
  kind: string;
  label: string;
  model: string;
  lastValidated: string;
  /** How the secret is held, masked: `env:NAME`, `encrypted`, `plaintext …k3Fd`, `file:path`, `none`. */
  secret: string;
  invalid?: string;
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** Describe how an entry holds its secret without ever revealing it. */
export function describeSecret(e: Record<string, unknown>): string {
  if (typeof e.apiKeyEnv === "string") return `env:${e.apiKeyEnv}`;
  const ref = e.secretRef;
  if (isRecord(ref)) {
    if (typeof ref.env === "string") return `env:${ref.env}`;
    if (typeof ref.file === "string") return `file:${ref.file}`;
    if (typeof ref.encrypted === "string") return "encrypted";
  }
  const s = e.secret;
  if (isRecord(s)) {
    const v = [s.apiKey, s.accessToken].find((x): x is string => typeof x === "string");
    if (v) return `plaintext ${maskSecret(v)}`;
    if (s.kind === "subscription") return "login";
    if (s.kind === "cloud") return "ambient";
    if (typeof s.baseUrl === "string") return "no key";
  }
  if (typeof e.baseUrl === "string") return "no key";
  return "none";
}

export function listEntries(file: RawConnectionsFile): ListedConnection[] {
  return file.connections.map((e) => {
    const parsed = connectionFileEntrySchema.safeParse(e);
    return {
      id: str(e.id) || "?",
      provider: str(e.provider),
      kind: str(e.kind),
      label: str(e.label),
      model: str(e.defaultModel),
      lastValidated: str(e.lastValidatedAt),
      secret: describeSecret(e),
      ...(parsed.success ? {} : { invalid: parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ") }),
    };
  });
}

export type { ConnectionsFile };
