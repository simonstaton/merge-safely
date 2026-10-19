import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when git could not be started or was killed. */
  code: number;
}

export interface GitOptions {
  cwd: string;
  /** Extra environment merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Kill git after this long. Default 10 minutes (fetches can be slow). */
  timeoutMs?: number;
}

/** Run git with an args array and no shell. Never rejects; inspect `code`. */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (code: number, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        code,
      });
    };
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(-1, `\ngit timed out after ${opts.timeoutMs ?? 600_000}ms`);
    }, opts.timeoutMs ?? 600_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e: Error) => done(-1, e.message));
    child.on("close", (code: number | null) => done(code ?? -1));
  });
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * Replace every occurrence of each secret (and its base64 forms, which is how tokens travel in
 * http.extraheader) with `***`, and strip userinfo from URLs.
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text.replace(URL_CREDENTIALS, "$1***@");
  const variants = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    variants.add(s);
    variants.add(Buffer.from(s).toString("base64"));
    variants.add(Buffer.from(`x-access-token:${s}`).toString("base64"));
  }
  // Longest first so a secret that contains another is replaced whole.
  for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}
