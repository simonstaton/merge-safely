import { spawn } from "node:child_process";

/** Environment variables passed to every subprocess. Everything else (API keys, tokens) is dropped. */
export const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "CI", "NODE_ENV"] as const;

/** Build a minimal environment from the allowlist so connection secrets never reach a subprocess. */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...extra };
}

export interface ProcResult {
  /** Exit code, or null when killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Combined stdout+stderr in arrival order, capped at maxBytes. */
  combined: string;
  /** True when any stream exceeded maxBytes and was cut. */
  overflow: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError?: string;
}

export interface ProcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Per-stream cap held in memory; the rest is discarded. */
  maxBytes: number;
  signal?: AbortSignal;
}

/**
 * Spawn without a shell, in its own process group, so a timeout or abort kills the whole tree.
 * Never rejects.
 */
export function runProcess(command: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const both: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let bothLen = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", combined: "", overflow, timedOut, aborted: true });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e: unknown) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        combined: "",
        overflow,
        timedOut,
        aborted,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const take = (chunk: Buffer, which: "out" | "err"): void => {
      if (which === "out") {
        if (outLen < opts.maxBytes) out.push(chunk);
        else overflow = true;
        outLen += chunk.length;
      } else {
        if (errLen < opts.maxBytes) err.push(chunk);
        else overflow = true;
        errLen += chunk.length;
      }
      if (bothLen < opts.maxBytes) both.push(chunk);
      bothLen += chunk.length;
    };
    child.stdout?.on("data", (c: Buffer) => take(c, "out"));
    child.stderr?.on("data", (c: Buffer) => take(c, "err"));

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Reap any grandchildren still holding the group after the leader exits.
      if (timedOut || aborted) killGroup();
      const cut = (bufs: Buffer[]): string => {
        const b = Buffer.concat(bufs);
        if (b.length > opts.maxBytes) overflow = true;
        return b.subarray(0, opts.maxBytes).toString("utf8");
      };
      const result: ProcResult = {
        code,
        stdout: cut(out),
        stderr: cut(err),
        combined: cut(both),
        overflow: overflow || bothLen > opts.maxBytes,
        timedOut,
        aborted,
      };
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };
    child.on("error", (e: Error) => finish(null, e.message));
    child.on("close", (code: number | null) => finish(code));
  });
}

/** True when `bin` resolves to an executable on PATH. Cached per process. */
const whichCache = new Map<string, Promise<boolean>>();
export function onPath(bin: string): Promise<boolean> {
  let p = whichCache.get(bin);
  if (!p) {
    p = runProcess(bin, ["--version"], {
      cwd: process.cwd(),
      env: scrubbedEnv(),
      timeoutMs: 5_000,
      maxBytes: 4096,
    }).then((r) => r.spawnError === undefined && r.code === 0);
    whichCache.set(bin, p);
  }
  return p;
}
