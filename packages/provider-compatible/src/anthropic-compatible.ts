import type {
  Connection,
  ModelInfo,
  ModelProvider,
  ModelRunner,
  RunnerOptions,
  ValidationResult,
} from "@merge-safely/core";
import { type AnthropicProviderOptions, anthropicProvider } from "@merge-safely/provider-anthropic";

/**
 * Any gateway or proxy speaking the Anthropic Messages API, registered as provider "anthropic-compatible".
 *
 * A thin preset over `anthropicProvider()`: validation, model listing and both runners (Messages API, and the
 * Claude Code CLI when the connection sets `options.runner: "cli"`) are the Anthropic adapter's own. That adapter
 * builds its SDK client from `secret.baseUrl` / `secret.apiKey` / `secret.headers` and points the CLI at the
 * gateway through `ANTHROPIC_BASE_URL`, so nothing here re-implements transport.
 */
export function anthropicCompatibleProvider(opts: AnthropicProviderOptions = {}): ModelProvider {
  const inner = anthropicProvider(opts);
  return {
    id: "anthropic-compatible",
    connectionKinds: ["anthropic-compatible"],

    async validate(conn: Connection): Promise<ValidationResult> {
      if (conn.secret.kind !== "anthropic-compatible") return { ok: false, message: unsupported(conn) };
      return inner.validate(conn);
    },

    models(conn: Connection): Promise<ModelInfo[]> {
      if (conn.secret.kind !== "anthropic-compatible") return Promise.reject(new Error(unsupported(conn)));
      return inner.models(conn);
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts?: RunnerOptions): ModelRunner {
      // Refuse rather than fall through to api.anthropic.com with a key meant for a gateway.
      if (conn.secret.kind !== "anthropic-compatible") throw new Error(unsupported(conn));
      return inner.createRunner(conn, model, runnerOpts);
    },
  };
}

function unsupported(conn: Connection): string {
  return `connection kind "${conn.secret.kind}" is not supported by the anthropic-compatible provider (connection ${conn.id})`;
}
