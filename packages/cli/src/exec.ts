import { execFile } from "node:child_process";

export interface ExecResult {
  /** Exit code; -1 when the binary could not be started (e.g. not installed) or was killed. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Run a binary without a shell. Never rejects: failures come back as a non-zero `code`. */
export const execCommand: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof err.code === "number" ? err.code : -1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
