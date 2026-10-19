import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

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

/** fsync a directory so a rename or link in it survives power loss. Platforms that cannot fsync a directory are skipped. */
export async function fsyncDir(dir: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch (err: unknown) {
    if (!["EISDIR", "EPERM", "EINVAL", "EBADF", "EACCES"].some((c) => isErrno(err, c))) throw err;
  } finally {
    await fh?.close();
  }
}

async function writeTemp(file: string, data: string, durable: boolean): Promise<string> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(data, "utf8");
    if (durable) await fh.sync();
  } catch (err: unknown) {
    await fh.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  return tmp;
}

/** Replace `file` atomically: temp file, fsync, rename, fsync the directory. Readers see old or new, never torn. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = await writeTemp(file, data, true);
  try {
    await rename(tmp, file);
  } catch (err: unknown) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dirname(file));
}

/**
 * Create `file` atomically only if it does not exist: the fully written temp file is hard-linked into place,
 * and link() fails with EEXIST if anything is already there. Returns false when the file already exists.
 */
export async function atomicCreate(file: string, data: string, opts: { durable?: boolean } = {}): Promise<boolean> {
  const durable = opts.durable ?? true;
  const tmp = await writeTemp(file, data, durable);
  try {
    await link(tmp, file);
  } catch (err: unknown) {
    if (isErrno(err, "EEXIST")) return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
  if (durable) await fsyncDir(dirname(file));
  return true;
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
  /** Give up waiting for a live lock after this long. Default 35 s, longer than staleMs so a crashed holder is always outlived. */
  timeoutMs?: number;
}

export const DEFAULT_LOCK_STALE_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 35_000;

export interface FileLock {
  readonly token: string;
  /** True while the lock file still carries this holder's token. Check it immediately before committing a write. */
  verify(): Promise<boolean>;
  /** Remove the lock if it is still ours. */
  release(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readToken(path: string): Promise<string | null> {
  const raw = await readFileOrNull(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const token = typeof parsed === "object" && parsed !== null ? (parsed as { token?: unknown }).token : undefined;
    return typeof token === "string" ? token : "";
  } catch (err: unknown) {
    void err;
    return ""; // garbage: treated as a token nobody holds
  }
}

async function lockAge(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (err: unknown) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * Break `path` if it is still the stale lock we observed (same token, still older than staleMs).
 * Breakers are serialised by `<path>.break` so two processes can never both break and then delete a fresh lock;
 * the stale lock is renamed to a unique tombstone and its token re-checked before being discarded.
 */
async function breakStale(path: string, observedToken: string | null, staleMs: number): Promise<void> {
  const breakPath = `${path}.break`;
  const breakToken = randomUUID();
  if (!(await atomicCreate(breakPath, breakToken, { durable: false }))) {
    // Another process is breaking. Its break lock can only go stale if it crashed mid-break.
    const age = await lockAge(breakPath);
    if (age !== null && age > staleMs) await rm(breakPath, { force: true });
    return;
  }
  try {
    const age = await lockAge(path);
    if (age === null || age <= staleMs || (await readToken(path)) !== observedToken) return;
    const tomb = `${path}.stale.${randomUUID()}`;
    try {
      await rename(path, tomb);
    } catch (err: unknown) {
      if (isErrno(err, "ENOENT")) return;
      throw err;
    }
    if ((await readToken(tomb)) !== observedToken) {
      // Not the lock we judged stale: put it back for its holder (if nobody re-took the path meanwhile).
      try {
        await link(tomb, path);
      } catch (err: unknown) {
        if (!isErrno(err, "EEXIST")) throw err;
      }
    }
    await rm(tomb, { force: true });
  } finally {
    if ((await readFileOrNull(breakPath)) === breakToken) await rm(breakPath, { force: true });
  }
}

/**
 * Cross-process advisory lock at `path`. The lock file is created atomically with its token already inside
 * (temp file + link), so a lock is never observed half-written. Holders call `verify()` right before committing.
 */
export async function acquireFileLock(path: string, opts: FileLockOptions = {}): Promise<FileLock> {
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let delay = 2;

  for (;;) {
    const token = `${process.pid}:${randomUUID()}`;
    const body = JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() });
    if (await atomicCreate(path, body, { durable: false })) {
      const verify = async () => (await readToken(path)) === token;
      return {
        token,
        verify,
        release: async () => {
          if (await verify()) await rm(path, { force: true });
        },
      };
    }

    const observedToken = await readToken(path);
    const age = await lockAge(path);
    if (observedToken === null || age === null) continue; // released between our attempts
    if (age > staleMs) {
      await breakStale(path, observedToken, staleMs);
      continue;
    }

    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${path}`);
    await sleep(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 50);
  }
}
