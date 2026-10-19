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
import { defaultClientFactory, type GeminiModel, type GenAILike } from "./client.js";
import { AgenticLoop } from "./common/loop.js";
import { errorMessage, redact, secretStrings } from "./common/redact.js";
import type { RetryOptions } from "./common/retry.js";
import { classifyGeminiError } from "./errors.js";
import { isAgenticModel, toModelInfo } from "./models.js";
import { GeminiTransport } from "./transport.js";

export interface GeminiProviderOptions {
  /** Inject a client (tests). Defaults to `@google/genai` against the Gemini Developer API. */
  clientFactory?: (conn: Connection) => GenAILike;
  /** Runner retry policy for 429/5xx/network failures. Defaults to 3 retries with jittered backoff. */
  retry?: RetryOptions;
}

const MAX_LISTED = 1_000;

export function geminiProvider(opts: GeminiProviderOptions = {}): ModelProvider {
  const factory = opts.clientFactory ?? defaultClientFactory;

  async function listModels(conn: Connection): Promise<ModelInfo[]> {
    const pager = await factory(conn).models.list();
    const out: GeminiModel[] = [];
    for await (const m of pager) {
      out.push(m);
      if (out.length >= MAX_LISTED) break;
    }
    return out
      .filter(isAgenticModel)
      .map((m) => toModelInfo(m, conn))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    id: "gemini",
    connectionKinds: ["api-key"],

    async validate(conn: Connection): Promise<ValidationResult> {
      const t0 = Date.now();
      const secrets = secretStrings(conn.secret);
      try {
        const models = await listModels(conn);
        return {
          ok: true,
          message: `connected to Gemini API; ${models.length} models`,
          models,
          latencyMs: Date.now() - t0,
        };
      } catch (err: unknown) {
        const latencyMs = Date.now() - t0;
        const info = classifyGeminiError(secrets)(err);
        if (info.kind === "auth") return { ok: false, message: "invalid API key: the provider rejected it", latencyMs };
        if (info.kind === "permission")
          return {
            ok: false,
            message: "the key was accepted but lacks permission (403); is the Generative Language API enabled?",
            latencyMs,
          };
        if (info.kind === "network")
          return { ok: false, message: `Gemini API unreachable (${info.message})`, latencyMs };
        return { ok: false, message: `validation failed: ${redact(info.message, secrets)}`, latencyMs };
      }
    },

    async models(conn: Connection): Promise<ModelInfo[]> {
      try {
        return await listModels(conn);
      } catch (err: unknown) {
        throw new Error(
          `could not list Gemini models: ${classifyGeminiError(secretStrings(conn.secret))(err).message}`,
        );
      }
    },

    createRunner(conn: Connection, model: ModelInfo, runnerOpts: RunnerOptions = {}): ModelRunner {
      const secrets = secretStrings(conn.secret);
      return {
        async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
          let client: GenAILike | undefined;
          let setupError: string | undefined;
          try {
            client = factory(conn);
          } catch (err: unknown) {
            setupError = `could not create Gemini client: ${redact(errorMessage(err), secrets)}`;
          }
          const loop = new AgenticLoop({
            model,
            options: runnerOpts,
            classify: classifyGeminiError(secrets),
            secrets,
            retry: opts.retry,
            supportsStrict: false,
            makeTransport: (init) => {
              if (!client) throw new Error(setupError ?? "client unavailable");
              return new GeminiTransport(client, model, init, runnerOpts.logger);
            },
          });
          return loop.run(seat, input, ws, signal);
        },
      };
    },
  };
}
