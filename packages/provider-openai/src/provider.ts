import type {
  Connection,
  ModelInfo,
  ModelProvider,
  ModelRunner,
  ReviewerInput,
  ReviewerRun,
  RunnerOptions,
  Seat,
  ValidationResult,
  WorkspaceHandle,
} from "@merge-safely/core";
import { defaultClientFactory, type OpenAILike } from "./client.js";
import { AgenticLoop } from "./common/loop.js";
import { errorMessage, redact, secretStrings } from "./common/redact.js";
import type { RetryOptions } from "./common/retry.js";
import { classifyOpenAIError } from "./errors.js";
import { isChatModelId, toModelInfo } from "./models.js";
import { ChatTransport } from "./transport-chat.js";
import { ResponsesTransport } from "./transport-responses.js";

export type OpenAIWireApi = "responses" | "chat";

export interface OpenAIProviderOptions {
  /** Inject a client (tests, custom transports). Defaults to the official SDK with retries disabled. */
  clientFactory?: (conn: Connection) => OpenAILike;
  /** Runner retry policy for 429/5xx/network failures. Defaults to 3 retries with jittered backoff. */
  retry?: RetryOptions;
}

/** `options.api` wins; otherwise Responses for api.openai.com and Chat Completions for compatible endpoints. */
export function wireApiFor(conn: Connection): OpenAIWireApi {
  const api = conn.options?.api;
  if (api === "responses" || api === "chat") return api;
  return conn.secret.kind === "openai-compatible" ? "chat" : "responses";
}

function hostOf(conn: Connection): string {
  if (conn.secret.kind !== "openai-compatible") return "api.openai.com";
  try {
    return new URL(conn.secret.baseUrl).host;
  } catch {
    return "the configured base URL";
  }
}

export function openaiProvider(opts: OpenAIProviderOptions = {}): ModelProvider {
  const factory = opts.clientFactory ?? defaultClientFactory;

  async function listModels(conn: Connection): Promise<ModelInfo[]> {
    const client = factory(conn);
    const { data } = await client.models.list();
    const ids = data.map((m) => m.id);
    const compatible = conn.secret.kind === "openai-compatible";
    return (compatible ? ids : ids.filter(isChatModelId)).sort().map((id) => toModelInfo(id, conn));
  }

  return {
    id: "openai",
    connectionKinds: ["api-key", "openai-compatible", "oauth"],

    async validate(conn: Connection): Promise<ValidationResult> {
      const t0 = Date.now();
      const secrets = secretStrings(conn.secret);
      const classify = classifyOpenAIError(secrets);
      try {
        const models = await listModels(conn);
        return {
          ok: true,
          message: `connected to ${hostOf(conn)}; ${models.length} models`,
          models,
          latencyMs: Date.now() - t0,
        };
      } catch (err: unknown) {
        const latencyMs = Date.now() - t0;
        const info = classify(err);
        if (info.kind === "auth")
          return { ok: false, message: "invalid API key: the provider rejected it (401)", latencyMs };
        if (info.kind === "permission")
          return { ok: false, message: "the key was accepted but lacks permission to list models (403)", latencyMs };
        if (info.kind === "not-found" && conn.secret.kind === "openai-compatible")
          return { ok: true, message: "base URL does not expose /models, assuming reachable", latencyMs };
        if (info.kind === "network")
          return { ok: false, message: `provider unreachable at ${hostOf(conn)} (${info.message})`, latencyMs };
        return { ok: false, message: `validation failed: ${redact(info.message, secrets)}`, latencyMs };
      }
    },

    async models(conn: Connection): Promise<ModelInfo[]> {
      try {
        return await listModels(conn);
      } catch (err: unknown) {
        if (conn.secret.kind === "openai-compatible") return [];
        throw new Error(
          `could not list OpenAI models: ${classifyOpenAIError(secretStrings(conn.secret))(err).message}`,
        );
      }
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts: RunnerOptions = {}): ModelRunner {
      const secrets = secretStrings(conn.secret);
      const api = wireApiFor(conn);
      return {
        async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
          let client: OpenAILike | undefined;
          let setupError: string | undefined;
          try {
            client = factory(conn);
          } catch (err: unknown) {
            setupError = `could not create OpenAI client: ${redact(errorMessage(err), secrets)}`;
          }
          const loop = new AgenticLoop({
            model,
            options: runnerOpts,
            classify: classifyOpenAIError(secrets),
            secrets,
            retry: opts.retry,
            // Strict function schemas are an OpenAI feature; gateways get them only on request via options.api.
            supportsStrict: true,
            makeTransport: (init) => {
              if (!client) throw new Error(setupError ?? "client unavailable");
              return api === "chat"
                ? new ChatTransport(client, model.name, init, runnerOpts.logger)
                : new ResponsesTransport(client, model.name, init, runnerOpts.logger);
            },
          });
          return loop.run(seat, input, ws, signal);
        },
      };
    },
  };
}
