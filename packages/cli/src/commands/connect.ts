import { join } from "node:path";
import type { Connection, ModelInfo, ModelProvider } from "@merge-safely/core";
import { MASTER_KEY_ENV, parseConnectionsInput, secretValues } from "@merge-safely/providers";
import { describeModel, modelsFor } from "@merge-safely/registry";
import { readRawConnections, toFileEntry, upsertEntry, writeRawConnections } from "../connections-file.js";
import { type TierCost, TYPICAL_PR_LINES, tierCosts } from "../cost.js";
import { CliError } from "../errors.js";
import { formatUsd, table } from "../io.js";
import { defaultLoadedPolicy, type LoadedPolicy, POLICY_FILE, readPolicyOrDefault } from "../policy.js";
import type { Runtime } from "../runtime.js";

export const CONNECT_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openai-compatible",
  "anthropic-compatible",
  "openrouter",
  "together",
  "groq",
  "fireworks",
  "ollama",
  "lmstudio",
] as const;
export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

/** Conventional key variable per provider, offered as the default env reference. */
export const DEFAULT_KEY_ENV: Partial<Record<ConnectProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  groq: "GROQ_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
};

const KEYLESS: ReadonlySet<string> = new Set(["ollama", "lmstudio"]);
const NEEDS_BASE_URL: ReadonlySet<string> = new Set(["openai-compatible", "anthropic-compatible"]);

export interface ConnectOptions {
  id?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  runner?: string;
  subscription?: boolean;
  label?: string;
  validate?: boolean;
}

function isConnectProvider(p: string): p is ConnectProvider {
  return (CONNECT_PROVIDERS as readonly string[]).includes(p);
}

function envSet(rt: Runtime, name: string | undefined): name is string {
  return name !== undefined && (rt.ctx.env[name]?.trim() ?? "") !== "";
}

interface KeyChoice {
  apiKey?: string;
  apiKeyEnv?: string;
}

async function chooseKey(rt: Runtime, provider: ConnectProvider, opts: ConnectOptions): Promise<KeyChoice> {
  if (opts.apiKey !== undefined && opts.apiKeyEnv !== undefined) {
    throw new CliError("USAGE", "give --api-key or --api-key-env, not both");
  }
  if (opts.apiKeyEnv !== undefined) {
    if (!envSet(rt, opts.apiKeyEnv)) {
      throw new CliError("MISSING_API_KEY", `environment variable ${opts.apiKeyEnv} is not set`);
    }
    return { apiKeyEnv: opts.apiKeyEnv };
  }
  if (opts.apiKey !== undefined) {
    rt.secrets.add(opts.apiKey);
    if (opts.apiKey.trim() === "") throw new CliError("MISSING_API_KEY", "--api-key is empty");
    rt.warn("--api-key puts the key in your shell history; prefer --api-key-env or the interactive prompt");
    return { apiKey: opts.apiKey.trim() };
  }
  if (opts.subscription || KEYLESS.has(provider)) return {};
  const def = DEFAULT_KEY_ENV[provider];
  if (provider === "openai-compatible" && !rt.interactive) return {}; // keyless gateways are allowed
  if (rt.interactive) {
    const hint = def && envSet(rt, def) ? `; leave empty to reference $${def}` : "";
    const key = await rt.prompter.secret(`API key for ${provider} (input hidden${hint})`);
    rt.secrets.add(key);
    if (key !== "") return { apiKey: key };
    if (def && envSet(rt, def)) return { apiKeyEnv: def };
    if (provider === "openai-compatible") return {};
    throw new CliError("MISSING_API_KEY", `no API key given for ${provider}`);
  }
  if (def && envSet(rt, def)) {
    rt.warn(`using the key from $${def} (stored as a reference to the variable, not the value)`);
    return { apiKeyEnv: def };
  }
  throw new CliError(
    "MISSING_API_KEY",
    `no API key for ${provider}: pass --api-key-env <ENV>${def ? ` (e.g. ${def})` : ""} or run interactively in a terminal`,
  );
}

function groupModels(models: ModelInfo[]): string[] {
  const lines: string[] = [];
  for (const tier of ["frontier", "mid", "small"] as const) {
    const ms = models.filter((m) => m.tier === tier);
    if (!ms.length) continue;
    const shown = ms.slice(0, 8).map((m) => `    ${describeModel(m)}  [${m.name}]`);
    if (ms.length > 8) shown.push(`    … ${ms.length - 8} more`);
    lines.push(`  ${tier}:`, ...shown);
  }
  return lines;
}

export function renderTierCosts(costs: TierCost[], policy: LoadedPolicy, lines = TYPICAL_PR_LINES): string {
  const rows = costs.map((c) => [
    `tier ${c.tier}`,
    `${c.hunters} hunter${c.hunters === 1 ? "" : "s"} + ${c.judges} judge run${c.judges === 1 ? "" : "s"}`,
    c.hunterModel?.name ?? "-",
    c.judgeModel?.name ?? "-",
    `${formatUsd(c.usd)}${c.pessimistic ? " (pessimistic rate)" : ""}`,
  ]);
  const b = policy.policy.budget;
  const ceiling = [
    `Budget ceiling: ${b.perSeatUsd > 0 ? formatUsd(b.perSeatUsd) : "no cap"} per seat, ${b.perChangeUsd > 0 ? formatUsd(b.perChangeUsd) : "no cap"} per change`,
    b.windowUsd !== null ? `, ${formatUsd(b.windowUsd)} per ${b.windowDays}-day window` : "",
    b.spendLimitUsd !== null ? `, ${formatUsd(b.spendLimitUsd)} all-time` : "",
    ` (${policy.source === "defaults" ? "policy defaults" : policy.source}).`,
  ].join("");
  return [
    `Estimated cost per review of a typical ${lines}-line PR (no prompt caching assumed):`,
    table(["tier", "seats", "hunters", "judges", "est. per PR"], rows),
    ceiling,
  ].join("\n");
}

export async function connectCommand(rt: Runtime, providerArg: string, opts: ConnectOptions): Promise<number> {
  const provider = providerArg.trim().toLowerCase();
  if (!isConnectProvider(provider)) {
    throw new CliError("USAGE", `unknown provider "${providerArg}"; choose one of: ${CONNECT_PROVIDERS.join(", ")}`);
  }
  if (opts.subscription && provider !== "anthropic") {
    throw new CliError("USAGE", "--subscription is only supported for anthropic (Claude Code login)");
  }
  if (opts.runner !== undefined && opts.runner !== "cli") throw new CliError("USAGE", '--runner only accepts "cli"');
  const id = opts.id ?? `${provider}-main`;
  let baseUrl = opts.baseUrl;
  if (!baseUrl && NEEDS_BASE_URL.has(provider)) {
    if (!rt.interactive) throw new CliError("USAGE", `${provider} needs --base-url <url>`);
    baseUrl = await rt.prompter.ask(`Base URL for ${provider} (e.g. https://gateway.example.com/v1)`);
    if (!baseUrl) throw new CliError("USAGE", `${provider} needs a base URL`);
  }
  const key = await chooseKey(rt, provider, opts);

  const inline: Record<string, unknown> = {
    provider,
    ...key,
    ...(baseUrl ? { baseUrl } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.subscription ? { subscription: true } : {}),
  };
  const parsed = parseConnectionsInput({ [id]: inline }, rt.ctx.env, { now: rt.ctx.now });
  const conn: Connection | undefined = parsed.connections[0];
  if (parsed.errors.length || !conn) {
    throw new CliError("CONNECTION_INVALID", parsed.errors.join("; ") || "could not build the connection");
  }
  rt.secrets.add(...secretValues(conn.secret));
  conn.createdBy = rt.ctx.env.USER ?? rt.ctx.env.USERNAME ?? "cli";

  let models: ModelInfo[] = [];
  if (opts.validate !== false) {
    let providerImpl: ModelProvider;
    try {
      providerImpl = rt.ctx.registry().forConnection(conn);
    } catch (err: unknown) {
      throw new CliError("PROVIDER_UNAVAILABLE", err instanceof Error ? err.message : String(err));
    }
    if (!rt.json) rt.err(`Validating ${id} …`);
    const v = await providerImpl.validate(conn);
    if (!v.ok) {
      throw new CliError(
        "VALIDATION_FAILED",
        `${id}: ${v.message ?? "validation failed"}. Nothing was saved; fix the key or pass --no-validate`,
      );
    }
    conn.lastValidatedAt = rt.ctx.now().toISOString();
    models = v.models ?? [];
    if (models.length === 0) {
      try {
        models = await providerImpl.models(conn);
      } catch (err: unknown) {
        rt.warn(`could not list models for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    models = modelsFor(conn.provider);
  }
  if (opts.model && models.length > 0 && !models.some((m) => m.name.toLowerCase() === opts.model?.toLowerCase())) {
    rt.warn(`model "${opts.model}" is not among the models ${id} lists; it will be used unchecked`);
  }

  let policy: LoadedPolicy;
  try {
    policy = await readPolicyOrDefault(join(rt.ctx.cwd, POLICY_FILE));
  } catch (_err: unknown) {
    policy = defaultLoadedPolicy();
  }
  const costs = tierCosts(models, policy.policy);

  const masterKey = rt.ctx.env[MASTER_KEY_ENV]?.trim() || undefined;
  if (masterKey) rt.secrets.add(masterKey);
  const { entry, warnings } = toFileEntry(conn, {
    ...(key.apiKeyEnv ? { envRef: key.apiKeyEnv } : masterKey ? { masterKey } : {}),
  });
  const { file } = await readRawConnections(rt.paths.connections);
  const replaced = upsertEntry(file, entry);
  await writeRawConnections(rt.paths.connections, file);
  for (const w of warnings) rt.warn(w);

  const storage = key.apiKeyEnv
    ? `reference to $${key.apiKeyEnv}`
    : masterKey
      ? `encrypted with $${MASTER_KEY_ENV}`
      : "secret" in entry && entry.secret
        ? "plaintext (0600)"
        : "no secret";
  if (rt.json) {
    rt.printJson({
      id,
      provider: conn.provider,
      kind: conn.kind,
      ...(conn.label ? { label: conn.label } : {}),
      validated: opts.validate !== false,
      models: models.map((m) => m.name),
      tierCosts: costs.map((c) => ({
        tier: c.tier,
        hunters: c.hunters,
        judges: c.judges,
        hunterModel: c.hunterModel?.name,
        judgeModel: c.judgeModel?.name,
        usd: c.usd,
      })),
      path: rt.paths.connections,
      storage,
      replaced,
    });
    return 0;
  }
  const c = rt.colour;
  rt.out(
    `${c.green("✓")} ${opts.validate === false ? "Saved (not validated)" : "Connected"} ${c.bold(id)} (${conn.provider}, ${conn.kind}${conn.label ? `, ${conn.label}` : ""})`,
  );
  if (models.length) {
    rt.out(
      `Models ${opts.validate === false ? "in the registry for this provider" : "this connection can reach"} (${models.length}):`,
    );
    for (const l of groupModels(models)) rt.out(l);
  } else {
    rt.out("No models listed; set one with --model or in the policy (budgets use the pessimistic rate).");
  }
  rt.out();
  rt.out(renderTierCosts(costs, policy));
  rt.out();
  rt.out(`${replaced ? "Replaced" : "Saved"} ${id} in ${rt.paths.connections} (secret: ${storage}).`);
  rt.out(`Use it in .merge-safely.yml as: models: { hunters: { connection: ${id}, model: <name> } }`);
  return 0;
}
