/**
 * Parsing, loading and saving connections.
 *
 * Two user-facing shapes are accepted (see `schema.ts`): the connections file
 * (`{ version: 1, connections: [...] }`) and the Action/App inline map (`{ [id]: { provider, apiKey, ... } }`).
 * Errors name connection ids, fields and environment variable names, never secret values.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Connection, ConnectionKind, ConnectionSecret } from "@merge-safely/core";
import type { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  type ConnectionFileEntry,
  type ConnectionsFile,
  connectionSecretSchema,
  connectionsFileSchema,
  type InlineConnection,
  inlineConnectionsMapSchema,
} from "./schema.js";

/** Environment variable holding the master key for encrypted secrets. */
export const MASTER_KEY_ENV = "MERGE_SAFELY_MASTER_KEY";
/** Environment variable overriding the merge-safely home directory. */
export const HOME_ENV = "MERGE_SAFELY_HOME";

export interface ParseConnectionsOptions {
  /** Master key for `secretRef.encrypted`. Defaults to `env.MERGE_SAFELY_MASTER_KEY`. */
  masterKey?: string | Buffer;
  /** Reader for `secretRef.file`. Without it, file references are reported as errors (keeps parsing pure). */
  readFile?: (path: string) => string;
  /** Clock for `createdAt` when the input does not carry one. */
  now?: () => Date;
}

export interface ParseConnectionsResult {
  connections: Connection[];
  errors: string[];
}

type Env = NodeJS.ProcessEnv;

function formatZodError(prefix: string, err: z.ZodError): string[] {
  return err.issues.map((i) => `${prefix}${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const CLOUD_PROVIDERS = new Set(["bedrock", "vertex", "azure-openai"]);

/** Infer the connection kind of an inline entry (design 6.1). Returns an error string when ambiguous. */
export function inferConnectionKind(c: InlineConnection): ConnectionKind | { error: string } {
  if (c.kind) return c.kind;
  const hasKey = c.apiKey !== undefined || c.apiKeyEnv !== undefined;
  const hasToken = c.accessToken !== undefined || c.accessTokenEnv !== undefined;
  if (c.baseUrl !== undefined) {
    if (c.provider === "anthropic" || c.provider === "anthropic-compatible") return "anthropic-compatible";
    // openai, openai-compatible, and every other gateway (openrouter, ollama, vllm...) speak the OpenAI API.
    return "openai-compatible";
  }
  if (c.subscription === true) {
    if (hasKey || hasToken) return { error: "subscription: true cannot be combined with apiKey or accessToken" };
    return "subscription";
  }
  if (hasToken) {
    if (hasKey) return { error: "give either apiKey or accessToken, not both" };
    return "oauth";
  }
  if (hasKey) return "api-key";
  if (CLOUD_PROVIDERS.has(c.provider) || c.region || c.projectOrResource || c.credentialsRef) return "cloud";
  return { error: "cannot infer the connection kind: give apiKey, apiKeyEnv, baseUrl, accessToken or kind" };
}

/** Resolve a literal-or-env value. Errors name the variable, never its value. */
function literalOrEnv(
  label: string,
  literal: string | undefined,
  envName: string | undefined,
  env: Env,
  required: boolean,
): { value?: string; error?: string } {
  if (literal !== undefined && envName !== undefined) return { error: `give ${label} or ${label}Env, not both` };
  if (envName !== undefined) {
    const v = env[envName];
    if (v === undefined || v.trim() === "") return { error: `${label}Env: environment variable ${envName} is not set` };
    return { value: v.trim() };
  }
  if (literal !== undefined) {
    if (literal.trim() === "") {
      return { error: `${label} is empty (is the secret it references set, e.g. the GitHub Actions secret?)` };
    }
    return { value: literal.trim() };
  }
  return required ? { error: `${label} is required` } : {};
}

function inlineToConnection(
  id: string,
  c: InlineConnection,
  env: Env,
  now: () => Date,
): { connection?: Connection; errors: string[] } {
  const p = `connections.${id}: `;
  const kind = inferConnectionKind(c);
  if (typeof kind !== "string") return { errors: [p + kind.error] };
  const errors: string[] = [];
  let secret: ConnectionSecret | undefined;
  const key = () => literalOrEnv("apiKey", c.apiKey, c.apiKeyEnv, env, kind !== "openai-compatible");
  switch (kind) {
    case "api-key": {
      const k = key();
      if (k.error) errors.push(p + k.error);
      else if (k.value) secret = { kind, apiKey: k.value };
      break;
    }
    case "openai-compatible":
    case "anthropic-compatible": {
      if (!c.baseUrl) {
        errors.push(`${p}baseUrl is required for kind ${kind}`);
        break;
      }
      const k = key();
      if (k.error) errors.push(p + k.error);
      else if (kind === "anthropic-compatible") {
        secret = { kind, baseUrl: c.baseUrl, apiKey: k.value ?? "", ...(c.headers ? { headers: c.headers } : {}) };
      } else {
        secret = {
          kind,
          baseUrl: c.baseUrl,
          ...(k.value ? { apiKey: k.value } : {}),
          ...(c.headers ? { headers: c.headers } : {}),
        };
      }
      break;
    }
    case "oauth": {
      const t = literalOrEnv("accessToken", c.accessToken, c.accessTokenEnv, env, true);
      if (t.error) errors.push(p + t.error);
      else if (t.value) {
        secret = {
          kind,
          accessToken: t.value,
          ...(c.refreshToken ? { refreshToken: c.refreshToken } : {}),
          ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
        };
      }
      break;
    }
    case "cloud":
      secret = {
        kind,
        ...(c.region ? { region: c.region } : {}),
        ...(c.projectOrResource ? { projectOrResource: c.projectOrResource } : {}),
        ...(c.credentialsRef ? { credentialsRef: c.credentialsRef } : {}),
      };
      break;
    case "subscription":
      if (c.provider !== "anthropic") errors.push(`${p}subscription connections are only supported for anthropic`);
      else secret = { kind, ...(c.credentialFileRef ? { credentialFileRef: c.credentialFileRef } : {}) };
      break;
  }
  if (errors.length || !secret) return { errors };
  const checked = connectionSecretSchema.safeParse(secret);
  if (!checked.success) return { errors: formatZodError(p, checked.error) };
  return {
    errors: [],
    connection: {
      id,
      provider: c.provider,
      kind,
      createdAt: now().toISOString(),
      ...(c.label ? { label: c.label } : {}),
      ...(c.model ? { defaultModel: c.model } : {}),
      ...(c.runner ? { options: { runner: c.runner } } : {}),
      secret: checked.data,
    },
  };
}

/** Build a secret for `kind` from a single resolved value (an env var or a plain-text file). */
function secretFromValue(
  kind: ConnectionKind,
  value: string,
  e: ConnectionFileEntry,
): { secret?: ConnectionSecret; error?: string } {
  switch (kind) {
    case "api-key":
      return { secret: { kind, apiKey: value } };
    case "openai-compatible":
    case "anthropic-compatible":
      if (!e.baseUrl) return { error: `baseUrl is required next to the secret reference for kind ${kind}` };
      return { secret: { kind, baseUrl: e.baseUrl, apiKey: value, ...(e.headers ? { headers: e.headers } : {}) } };
    case "oauth":
      return { secret: { kind, accessToken: value } };
    default:
      return { error: `a plain secret value cannot be used for kind ${kind}; give an inline secret instead` };
  }
}

function fileEntryToConnection(
  e: ConnectionFileEntry,
  env: Env,
  opts: ParseConnectionsOptions,
  now: () => Date,
): { connection?: Connection; errors: string[] } {
  const p = `connections.${e.id}: `;
  const refCount = [e.secret, e.secretRef, e.apiKeyEnv].filter((x) => x !== undefined).length;
  if (refCount > 1) return { errors: [`${p}give only one of secret, secretRef or apiKeyEnv`] };
  if (e.secret && (e.baseUrl || e.headers)) {
    return { errors: [`${p}baseUrl/headers belong inside secret when secret is given inline`] };
  }

  const ref = e.apiKeyEnv !== undefined ? { env: e.apiKeyEnv } : e.secretRef;
  let secret: ConnectionSecret | undefined;
  if (e.secret) {
    secret = e.secret;
  } else if (ref && "env" in ref) {
    const v = env[ref.env];
    if (v === undefined || v.trim() === "") return { errors: [`${p}environment variable ${ref.env} is not set`] };
    const r = secretFromValue(e.kind, v.trim(), e);
    if (r.error) return { errors: [p + r.error] };
    secret = r.secret;
  } else if (ref && "file" in ref) {
    if (!opts.readFile) return { errors: [`${p}secretRef.file is only supported when loading a connections file`] };
    let content: string;
    try {
      content = opts.readFile(ref.file);
    } catch (_err: unknown) {
      return { errors: [`${p}could not read secret file ${ref.file}`] };
    }
    const trimmed = content.trim();
    if (trimmed === "") return { errors: [`${p}secret file ${ref.file} is empty`] };
    let asJson: unknown;
    if (trimmed.startsWith("{")) {
      try {
        asJson = JSON.parse(trimmed);
      } catch (_err: unknown) {
        return { errors: [`${p}secret file ${ref.file} looks like JSON but does not parse`] };
      }
    }
    if (asJson !== undefined) {
      const parsed = connectionSecretSchema.safeParse(asJson);
      if (!parsed.success) return { errors: formatZodError(`${p}secret file ${ref.file}: `, parsed.error) };
      secret = parsed.data;
    } else {
      const r = secretFromValue(e.kind, trimmed, e);
      if (r.error) return { errors: [p + r.error] };
      secret = r.secret;
    }
  } else if (ref && "encrypted" in ref) {
    const mk = opts.masterKey ?? env[MASTER_KEY_ENV];
    if (!mk) return { errors: [`${p}secret is encrypted but no master key is available (set ${MASTER_KEY_ENV})`] };
    try {
      secret = decryptSecret(ref.encrypted, mk, e.id);
    } catch (err: unknown) {
      return { errors: [`${p}${err instanceof Error ? err.message : "could not decrypt secret"}`] };
    }
  } else if (e.kind === "cloud" || e.kind === "subscription") {
    secret = { kind: e.kind };
  } else if (e.kind === "openai-compatible" && e.baseUrl) {
    secret = { kind: e.kind, baseUrl: e.baseUrl, ...(e.headers ? { headers: e.headers } : {}) };
  } else {
    return { errors: [`${p}no secret: give secret, secretRef or apiKeyEnv`] };
  }

  if (!secret) return { errors: [`${p}no secret resolved`] };
  if (secret.kind !== e.kind) return { errors: [`${p}secret kind ${secret.kind} does not match kind ${e.kind}`] };
  return {
    errors: [],
    connection: {
      id: e.id,
      provider: e.provider,
      kind: e.kind,
      createdAt: e.createdAt ?? now().toISOString(),
      ...(e.label !== undefined ? { label: e.label } : {}),
      ...(e.createdBy !== undefined ? { createdBy: e.createdBy } : {}),
      ...(e.lastValidatedAt !== undefined ? { lastValidatedAt: e.lastValidatedAt } : {}),
      ...(e.scopes !== undefined ? { scopes: e.scopes } : {}),
      ...(e.defaultModel !== undefined ? { defaultModel: e.defaultModel } : {}),
      ...(e.options !== undefined ? { options: e.options } : {}),
      secret,
    },
  };
}

/**
 * Parse user-supplied connections in either shape. A JSON string is accepted too.
 * Bad entries are reported in `errors` and left out; good entries are still returned.
 */
export function parseConnectionsInput(
  obj: unknown,
  env: Env = process.env,
  opts: ParseConnectionsOptions = {},
): ParseConnectionsResult {
  const now = opts.now ?? (() => new Date());
  let input = obj;
  if (typeof input === "string") {
    if (input.trim() === "") return { connections: [], errors: [] };
    try {
      input = JSON.parse(input);
    } catch (_err: unknown) {
      return { connections: [], errors: ["connections input is a string but not valid JSON"] };
    }
  }
  if (input === undefined || input === null) return { connections: [], errors: [] };
  if (!isRecord(input)) return { connections: [], errors: ["connections input must be an object"] };

  const connections: Connection[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const push = (r: { connection?: Connection; errors: string[] }) => {
    errors.push(...r.errors);
    if (!r.connection) return;
    if (seen.has(r.connection.id)) {
      errors.push(`connections.${r.connection.id}: duplicate connection id`);
      return;
    }
    seen.add(r.connection.id);
    connections.push(r.connection);
  };

  if ("connections" in input && Array.isArray(input.connections)) {
    // File shape. Validate entries one by one so one bad entry does not hide the rest.
    if (input.version !== 1) errors.push("version: expected 1");
    const entries: unknown[] = input.connections;
    entries.forEach((raw, i) => {
      const parsed = connectionsFileSchema.shape.connections.element.safeParse(raw);
      if (!parsed.success) {
        const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : String(i);
        errors.push(...formatZodError(`connections.${id}: `, parsed.error));
        return;
      }
      push(fileEntryToConnection(parsed.data, env, opts, now));
    });
    return { connections, errors };
  }

  for (const [id, raw] of Object.entries(input)) {
    const parsed = inlineConnectionsMapSchema.safeParse({ [id]: raw });
    if (!parsed.success) {
      errors.push(...formatZodError("connections.", parsed.error));
      continue;
    }
    const c = parsed.data[id];
    if (c) push(inlineToConnection(id, c, env, now));
  }
  return { connections, errors };
}

/** `$MERGE_SAFELY_HOME/connections.json`, defaulting to `~/.merge-safely/connections.json`. */
export function defaultConnectionsPath(env: Env = process.env): string {
  const home = env[HOME_ENV];
  return join(home && home.trim() !== "" ? home : join(homedir(), ".merge-safely"), "connections.json");
}

export interface ReadConnectionsFileResult extends ParseConnectionsResult {
  warnings: string[];
  path: string;
}

/** Read and parse a connections file without throwing on bad entries. A missing file yields no connections. */
export async function readConnectionsFile(
  path?: string,
  env: Env = process.env,
  opts: Pick<ParseConnectionsOptions, "masterKey" | "now"> = {},
): Promise<ReadConnectionsFileResult & { missing: boolean }> {
  const file = path ?? defaultConnectionsPath(env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err: unknown) {
    if (isRecord(err) && err.code === "ENOENT") {
      return { connections: [], errors: [], warnings: [], path: file, missing: true };
    }
    return {
      connections: [],
      errors: [`could not read connections file ${file}`],
      warnings: [],
      path: file,
      missing: false,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (_err: unknown) {
    return {
      connections: [],
      errors: [`connections file ${file} is not valid JSON`],
      warnings: [],
      path: file,
      missing: false,
    };
  }
  const warnings: string[] = [];
  try {
    const st = await stat(file);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      warnings.push(`connections file ${file} is readable by other users; run: chmod 600 ${file}`);
    }
  } catch (_err: unknown) {
    // stat failing after a successful read is not worth failing the load over.
  }
  const base = dirname(resolve(file));
  const parsed = parseConnectionsInput(json, env, {
    ...opts,
    readFile: (p) => readFileSync(isAbsolute(p) ? p : resolve(base, p), "utf8"),
  });
  return { ...parsed, warnings, path: file, missing: false };
}

/**
 * Load connections from a file (default `defaultConnectionsPath(env)`).
 * A missing default file yields `[]`; a missing explicit path or any invalid entry throws.
 */
export async function loadConnectionsFile(
  path?: string,
  env: Env = process.env,
  opts: Pick<ParseConnectionsOptions, "masterKey" | "now"> = {},
): Promise<Connection[]> {
  const r = await readConnectionsFile(path, env, opts);
  if (r.missing && path !== undefined) throw new Error(`connections file not found: ${r.path}`);
  if (r.errors.length) throw new Error(`invalid connections file ${r.path}:\n  - ${r.errors.join("\n  - ")}`);
  return r.connections;
}

export interface SaveConnectionsOptions {
  /** When given, every secret is written envelope-encrypted (`secretRef.encrypted`). */
  masterKey?: string | Buffer;
  /** Connection id -> env var name. Used when no master key: the secret is written as `secretRef.env`. */
  envRefs?: Record<string, string>;
}

export interface SaveConnectionsResult {
  path: string;
  warnings: string[];
}

function toFileEntry(conn: Connection, opts: SaveConnectionsOptions, warnings: string[]): ConnectionFileEntry {
  const { secret, ...record } = conn;
  const base: ConnectionFileEntry = { ...record };
  if (opts.masterKey !== undefined) {
    return { ...base, secretRef: { encrypted: encryptSecret(secret, opts.masterKey, conn.id) } };
  }
  if (secret.kind === "cloud" || secret.kind === "subscription") {
    // Only references (region, credential file path) — nothing secret to protect.
    return { ...base, secret };
  }
  const envName = opts.envRefs?.[conn.id];
  if (envName) {
    if (secret.kind === "openai-compatible" || secret.kind === "anthropic-compatible") {
      if (secret.headers && Object.keys(secret.headers).length) {
        warnings.push(`connection ${conn.id}: headers are stored in plaintext next to the env reference`);
      }
      return {
        ...base,
        baseUrl: secret.baseUrl,
        ...(secret.headers ? { headers: secret.headers } : {}),
        secretRef: { env: envName },
      };
    }
    if (secret.kind === "oauth" && secret.refreshToken) {
      warnings.push(`connection ${conn.id}: refresh token is not stored when using an env reference`);
    }
    return { ...base, secretRef: { env: envName } };
  }
  warnings.push(
    `connection ${conn.id}: secret stored in plaintext (file mode 0600); set ${MASTER_KEY_ENV} to encrypt it`,
  );
  return { ...base, secret };
}

/**
 * Write a connections file atomically with mode 0600 (directory 0700).
 * Secrets are encrypted with `masterKey` when given, else written as `secretRef.env` for ids in `envRefs`,
 * else written in plaintext with a warning.
 */
export async function saveConnectionsFile(
  path: string,
  records: Connection[],
  opts: SaveConnectionsOptions = {},
): Promise<SaveConnectionsResult> {
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) throw new Error(`duplicate connection id: ${r.id}`);
    ids.add(r.id);
  }
  const file: ConnectionsFile = { version: 1, connections: records.map((r) => toFileEntry(r, opts, warnings)) };
  const checked = connectionsFileSchema.safeParse(file);
  if (!checked.success) {
    throw new Error(
      `refusing to write an invalid connections file:\n  - ${formatZodError("", checked.error).join("\n  - ")}`,
    );
  }
  const dir = dirname(resolve(path));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.connections.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err: unknown) {
    await unlink(tmp).catch(() => undefined);
    const code = isRecord(err) && typeof err.code === "string" ? ` (${err.code})` : "";
    throw new Error(`could not write connections file ${path}${code}`);
  }
  await chmod(path, 0o600);
  return { path, warnings };
}
