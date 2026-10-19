import { normaliseModelId } from "../panel/model-id.js";
import { findInCatalog } from "../panel/seating.js";
import { policyHash } from "../policy/index.js";
import type { Policy } from "../policy/schema.js";
import type { Clock, Logger } from "../ports.js";
import type { Change, MetricEvent, ModelInfo, ModelRef, ReportEvent } from "../types.js";
import { GateError, type GateErrorCode, isGateError } from "./errors.js";
import type { GateDeps } from "./types.js";
import { connectionSecrets, errorText, NOOP_LOGGER, scrub } from "./util.js";

export const DEFAULT_PRODUCED_BY = "@merge-safely/core@0.1.0";
export const DEFAULT_CONCURRENCY = 4;

/** Resolved dependencies plus defaults. Built once per gate; holds no per-review state. */
export interface Env {
  deps: GateDeps;
  policy: Policy;
  policyHash: string;
  clock: Clock;
  logger: Logger;
  producedBy: string;
  concurrency: number;
  secrets: string[];
  normalise: (id: string) => string;
}

export function makeEnv(deps: GateDeps): Env {
  const normalise = deps.pricing.normalise ? (id: string) => deps.pricing.normalise?.(id) ?? id : normaliseModelId;
  return {
    deps,
    policy: deps.policy,
    policyHash: deps.policyHash ?? policyHash(deps.policy),
    clock: deps.clock ?? { now: () => new Date() },
    logger: deps.logger ?? NOOP_LOGGER,
    producedBy: deps.producedBy ?? DEFAULT_PRODUCED_BY,
    concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY,
    secrets: connectionSecrets(deps.connections),
    normalise,
  };
}

export const nowIso = (env: Env): string => env.clock.now().toISOString();

export function safeText(env: Env, err: unknown, max = 1_000): string {
  return scrub(errorText(err), env.secrets, max);
}

/** Convert anything thrown into a GateError with a scrubbed message. */
export function toGateError(env: Env, err: unknown, code: GateErrorCode = "internal", prefix?: string): GateError {
  if (isGateError(err)) return err;
  const msg = safeText(env, err);
  return new GateError(code, prefix ? `${prefix}: ${msg}` : msg);
}

/** Call a port, converting any throw into a GateError of the given code. */
export async function guard<T>(env: Env, code: GateErrorCode, what: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw toGateError(env, err, code, what);
  }
}

/** The catalog for a connection; a throwing catalog is treated as empty (logged). */
export function catalogOf(env: Env, connectionId: string): ModelInfo[] {
  try {
    return env.deps.catalog(connectionId);
  } catch (err: unknown) {
    env.logger.warn("catalog lookup failed", { connectionId, error: safeText(env, err) });
    return [];
  }
}

/** Model info for a ref, priced (pessimistically when unknown). The ref's own name is what the runner calls. */
export function modelInfoFor(env: Env, ref: ModelRef): ModelInfo {
  const found = findInCatalog(catalogOf(env, ref.connectionId), ref.name, { normalise: env.normalise });
  const base: ModelInfo = found
    ? { ...found, name: ref.name }
    : {
        provider: ref.provider,
        name: ref.name,
        supportsTools: true,
        supportsStructuredOutput: true,
        contextTokens: 0,
        maxOutputTokens: 0,
        tier: "mid",
      };
  try {
    return env.deps.pricing.withPricing(base);
  } catch (err: unknown) {
    env.logger.warn("pricing lookup failed", { model: ref.name, error: safeText(env, err) });
    return base;
  }
}

export function emit(
  env: Env,
  name: string,
  value: number,
  unit: MetricEvent["unit"],
  tags: MetricEvent["tags"],
): void {
  const m = env.deps.metrics;
  if (!m) return;
  try {
    const event: MetricEvent = { name, value, tags, at: nowIso(env) };
    if (unit) event.unit = unit;
    m.emit(event);
  } catch (err: unknown) {
    env.logger.warn("metrics emit failed", { name, error: safeText(env, err) });
  }
}

/** Per-call state: the events reported so far and whether an error event already went out. */
export class RunState {
  readonly events: ReportEvent[] = [];
  change?: Change;
  round = 0;
  errorReported = false;
}

/** Report to every reporter. A failing reporter is logged and never fails the review. */
export async function report(env: Env, state: RunState, event: ReportEvent): Promise<void> {
  state.events.push(event);
  await Promise.all(
    env.deps.reporters.map(async (r, i) => {
      try {
        await r.report(event);
      } catch (err: unknown) {
        env.logger.error("reporter failed", { reporter: i, event: event.type, error: safeText(env, err) });
      }
    }),
  );
}

/** Report an error event (once per call) when a change is known, then return the GateError to throw. */
export async function fail(env: Env, state: RunState, err: unknown): Promise<GateError> {
  const gateErr = toGateError(env, err);
  if (state.change && !state.errorReported) {
    state.errorReported = true;
    await report(env, state, { type: "error", change: state.change, error: gateErr.message, round: state.round });
  }
  emit(env, "merge_safely.review.error", 1, "count", { code: gateErr.code });
  return gateErr;
}
