import { execFile } from "node:child_process";
import type {
  Connection,
  ConnectionKind,
  ModelInfo,
  ModelProvider,
  ModelRunner,
  RunnerOptions,
  ValidationResult,
} from "@merge-safely/core";
import { ClaudeCodeRunner, type ClaudeCodeRunnerConfig } from "./cli-runner.js";
import { type AnthropicLike, createAnthropicClient, describeApiError } from "./client.js";
import { MessagesRunner, type MessagesRunnerConfig } from "./messages-runner.js";
import { localModels, toModelInfo } from "./models.js";
import { scrub, secretValues } from "./secrets.js";

export interface AnthropicProviderOptions {
  /** Custom fetch for the SDK (proxies, tests). */
  fetch?: typeof fetch;
  /** Replace the SDK client entirely (tests, custom transports). */
  clientFactory?: (conn: Connection) => AnthropicLike;
  /** Defaults for the CLI runner (binary path, kill grace, env passthrough). */
  cli?: ClaudeCodeRunnerConfig;
  /** Defaults for the Messages runner (retry tuning). */
  messages?: MessagesRunnerConfig;
  /** Timeout for validate() calls. Default 15s. */
  validateTimeoutMs?: number;
}

export const ANTHROPIC_CONNECTION_KINDS: ConnectionKind[] = [
  "api-key",
  "oauth",
  "anthropic-compatible",
  "subscription",
];

/** True when this connection runs through the Claude Code CLI rather than the Messages API. */
export function usesCliRunner(conn: Connection): boolean {
  return conn.kind === "subscription" || conn.secret.kind === "subscription" || conn.options?.runner === "cli";
}

function cliBinary(conn: Connection, opts: AnthropicProviderOptions): string {
  const fromConn = typeof conn.options?.claudeBinary === "string" ? conn.options.claudeBinary : undefined;
  return opts.cli?.binary ?? fromConn ?? "claude";
}

function cliVersion(
  binary: string,
  timeoutMs: number,
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            message:
              code === "ENOENT"
                ? `claude CLI not found on PATH ("${binary}"); install Claude Code and run \`claude\` once to log in`
                : "claude CLI did not respond to --version",
          });
          return;
        }
        resolve({ ok: true, version: String(stdout).trim().split(/\s+/)[0] ?? "unknown" });
      },
    );
  });
}

export function anthropicProvider(opts: AnthropicProviderOptions = {}): ModelProvider {
  const clientFor = (conn: Connection): AnthropicLike =>
    opts.clientFactory ? opts.clientFactory(conn) : createAnthropicClient(conn, opts.fetch);
  const validateTimeoutMs = opts.validateTimeoutMs ?? 15_000;

  async function listRuntime(conn: Connection, signal?: AbortSignal): Promise<ModelInfo[]> {
    const page = await clientFor(conn).models.list(signal ? { signal } : undefined);
    return page.data.filter((m) => typeof m.id === "string").map((m) => toModelInfo(m, "runtime"));
  }

  return {
    id: "anthropic",
    connectionKinds: ANTHROPIC_CONNECTION_KINDS,

    async validate(conn: Connection): Promise<ValidationResult> {
      const t0 = Date.now();
      if (!ANTHROPIC_CONNECTION_KINDS.includes(conn.secret.kind)) {
        return {
          ok: false,
          message: `connection kind "${conn.secret.kind}" is not supported by the anthropic provider`,
        };
      }
      if (conn.secret.kind === "subscription") {
        const v = await cliVersion(cliBinary(conn, opts), validateTimeoutMs);
        const latencyMs = Date.now() - t0;
        if (!v.ok) return { ok: false, message: v.message, latencyMs };
        return {
          ok: true,
          message: `claude CLI ${v.version} found; uses your personal Claude login (plan-included, your terms)`,
          models: localModels({ planIncluded: true }),
          latencyMs,
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), validateTimeoutMs);
      try {
        const models = await listRuntime(conn, controller.signal);
        return { ok: true, models, latencyMs: Date.now() - t0 };
      } catch (err: unknown) {
        const info = describeApiError(err);
        let message: string;
        if (info.aborted) message = "unreachable (timed out)";
        else if (info.status === 401) message = "invalid key";
        else if (info.status === 403) message = "key lacks permission to list models";
        else if (info.status === undefined) message = "unreachable";
        else message = info.message;
        return { ok: false, message: scrub(message, secretValues(conn)), latencyMs: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    },

    async models(conn: Connection): Promise<ModelInfo[]> {
      if (conn.secret.kind === "subscription") return localModels({ planIncluded: true });
      try {
        const runtime = await listRuntime(conn);
        return runtime.length > 0 ? runtime : localModels({ planIncluded: false });
      } catch {
        // Listing is best-effort; validate() reports reachability. Fall back to the local table.
        return localModels({ planIncluded: false });
      }
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts?: RunnerOptions): ModelRunner {
      if (usesCliRunner(conn)) return new ClaudeCodeRunner(conn, model, runnerOpts, opts.cli);
      return new MessagesRunner(clientFor(conn), conn, model, runnerOpts, opts.messages);
    },
  };
}
