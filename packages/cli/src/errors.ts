import { redactText } from "@merge-safely/core";
import { scrubText } from "@merge-safely/providers";

/** Process exit codes. Documented in the README; scripts and hooks depend on them. */
export const EXIT = {
  pass: 0,
  block: 1,
  /** Pending, contested, an error, or a usage/configuration problem. */
  pending: 2,
  error: 2,
  budgetBlocked: 3,
} as const;

/** A CLI-level failure with a stable code (printed in brackets) and the exit code to use. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode: number = EXIT.error) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** The error's code: `CliError`/`GateError` codes, Node errno codes, else a generic one. */
export function errorCode(err: unknown): string {
  if (isRecord(err) && typeof err.code === "string" && err.code !== "") return err.code;
  if (err instanceof Error && err.name && err.name !== "Error") return toCode(err.name);
  return "ERROR";
}

function toCode(name: string): string {
  return name
    .replace(/Error$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .concat(name.endsWith("Error") ? "_ERROR" : "");
}

/** Exit code for an error: a CliError's own, else the generic error code. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (isRecord(err) && typeof err.exitCode === "number") return err.exitCode;
  return EXIT.error;
}

/** Collects every secret value the CLI has seen so error output can mask them. */
export class SecretSet {
  private readonly values = new Set<string>();
  add(...values: Array<string | undefined>): void {
    for (const v of values) if (v && v.length >= 6) this.values.add(v);
  }
  list(): string[] {
    return [...this.values];
  }
  scrub(text: string): string {
    return redactText(scrubText(text, this.list()));
  }
}

/**
 * One line, no secrets: `error [CODE]: message`. Multi-line messages are joined with "; " so logs and CI
 * annotations keep the whole story on the line that carries the code.
 */
export function formatError(err: unknown, secrets?: SecretSet): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^- /, ""))
    .filter((l) => l !== "")
    .join("; ")
    .replace(/:;/g, ":");
  const msg = secrets ? secrets.scrub(oneLine) : redactText(oneLine);
  return `error [${errorCode(err)}]: ${msg}`;
}
