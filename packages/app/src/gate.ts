/**
 * Gate construction, behind one factory so tests inject a fake gate. Production uses core's `createGate`.
 */
import { createGate, type Gate, type GateDeps, type GateErrorCode } from "@merge-safely/core";

export type {
  Gate,
  GateDeps,
  GateErrorCode,
  HumanVerdictInput,
  Pricing,
  PromptBuilders,
  PromptBuildOptions,
  ReviewResult,
} from "@merge-safely/core";

export type GateFactory = (deps: GateDeps) => Gate;

const CODES: readonly string[] = ["head-moved", "seating", "budget", "store-conflict", "source", "policy", "internal"];

/** The GateError code of an error (structural, so it also works across duplicated module copies). */
export function gateErrorCode(err: unknown): GateErrorCode | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === "SeatingError") return "seating";
  if (e.name !== "GateError" || typeof e.code !== "string") return undefined;
  return CODES.includes(e.code) ? (e.code as GateErrorCode) : undefined;
}

/** The production factory: core's `createGate`. */
export const defaultGateFactory: GateFactory = (deps) => createGate(deps);
