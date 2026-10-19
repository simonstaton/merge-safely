/** Failure modes of the gate. Messages are always secret-scrubbed before a GateError is constructed. */
export type GateErrorCode = "head-moved" | "seating" | "budget" | "store-conflict" | "source" | "policy" | "internal";

export class GateError extends Error {
  readonly code: GateErrorCode;
  /** A user-facing hint for how to fix it, when there is one (e.g. the policy key to change). */
  readonly fix?: string;

  constructor(code: GateErrorCode, message: string, opts: { fix?: string } = {}) {
    super(message);
    this.name = "GateError";
    this.code = code;
    if (opts.fix !== undefined) this.fix = opts.fix;
  }
}

export function isGateError(err: unknown): err is GateError {
  return err instanceof GateError;
}
