import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

/**
 * Encode one untrusted value as a single safe path segment: no separators, no dot segments.
 * Dots are percent-encoded too so "." and ".." can never be produced.
 */
export function encodeSegment(value: string): string {
  if (value.length === 0) throw new Error("path segment must not be empty");
  return encodeURIComponent(value).replace(/\./g, "%2E").replace(/\*/g, "%2A");
}

/** Write via a sibling temp file, fsync, then rename, so readers see either the old or the new file, never a torn one. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err: unknown) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err: unknown) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/** Serialises async work per key inside one process. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface FileLockOptions {
  /** A lock file older than this is presumed abandoned by a crashed process and broken. Default 30 s. */
  staleMs?: number;
  /** Give up waiting for a live lock after this long. Default 10 s. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-process advisory lock: `<path>` created with O_EXCL ("wx"). Returns a release function.
 * Release only removes the lock if it still holds our token, so a lock broken as stale and re-taken
 * by another process is not deleted out from under it.
 */
export async function acquireFileLock(path: string, opts: FileLockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  let delay = 2;

  for (;;) {
    try {
      const fh = await open(path, "wx");
      try {
        await fh.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }), "utf8");
      } finally {
        await fh.close();
      }
      return async () => {
        const held = await readFileOrNull(path);
        if (held?.includes(token)) await rm(path, { force: true });
      };
    } catch (err: unknown) {
      if (!isErrno(err, "EEXIST")) throw err;
    }

    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > staleMs) {
        await rm(path, { force: true });
        continue;
      }
    } catch (err: unknown) {
      if (isErrno(err, "ENOENT")) continue;
      throw err;
    }

    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${path}`);
    await sleep(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 50);
  }
}
