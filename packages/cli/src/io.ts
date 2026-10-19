/** Output plumbing: injectable streams, colour that turns itself off when not a TTY, and plain tables. */

export interface Writer {
  write(s: string): unknown;
}

export interface CliIO {
  stdout: Writer;
  stderr: Writer;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export function processIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

export interface Colour {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function wrap(open: number, close: number, on: boolean): (s: string) => string {
  return on ? (s) => `\u001b[${open}m${s}\u001b[${close}m` : (s) => s;
}

/** Colour is on only for a TTY, and never when NO_COLOR is set or --no-color was given. */
export function makeColour(opts: { isTTY: boolean; env: NodeJS.ProcessEnv; flag?: boolean }): Colour {
  const noColor = opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== "";
  const on = opts.isTTY && !noColor && opts.flag !== false && opts.env.TERM !== "dumb";
  return {
    enabled: on,
    bold: wrap(1, 22, on),
    dim: wrap(2, 22, on),
    red: wrap(31, 39, on),
    green: wrap(32, 39, on),
    yellow: wrap(33, 39, on),
    cyan: wrap(36, 39, on),
  };
}

/** Left-aligned text table with a header row. Cells must already be safe to print. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "unknown";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
