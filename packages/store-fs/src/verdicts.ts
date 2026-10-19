import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RepoRef, Verdict, VerdictKey, VerdictStore } from "@merge-safely/core";
import {
  acquireFileLock,
  atomicWrite,
  encodeSegment,
  type FileLockOptions,
  isErrno,
  KeyedMutex,
  readFileOrNull,
} from "./io.js";
import { verdictKeyString } from "./key.js";

/** On-disk envelope. The nonce makes every write's bytes, and therefore its version, unique. */
interface Envelope {
  schema: 1;
  nonce: string;
  writtenAt: string;
  verdict: Verdict;
}

export interface FsVerdictStoreOptions {
  lock?: FileLockOptions;
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function changeDir(root: string, repo: RepoRef, number: number): string {
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("change number must be a non-negative integer");
  return join(
    root,
    "verdicts",
    encodeSegment(repo.host.toLowerCase()),
    encodeSegment(repo.owner),
    encodeSegment(repo.name),
    String(number),
  );
}

function verdictFile(root: string, key: VerdictKey): string {
  return join(changeDir(root, key.repo, key.number), `${encodeSegment(key.headSha.toLowerCase())}.json`);
}

function parseEnvelope(raw: string, file: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    void err;
    throw new Error(`corrupt verdict file ${file}: not JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== 1 ||
    typeof (parsed as { verdict?: unknown }).verdict !== "object"
  ) {
    throw new Error(`corrupt verdict file ${file}: unknown envelope`);
  }
  return parsed as Envelope;
}

/**
 * Filesystem VerdictStore: one JSON file per verdict at
 * `<dir>/verdicts/<host>/<owner>/<name>/<number>/<sha>.json`.
 *
 * - version = sha256 of the file's bytes (each write carries a fresh nonce, so versions never repeat)
 * - writes are atomic (temp file + fsync + rename)
 * - compare-and-set is serialised by an in-process mutex per key and a `<file>.lock` O_EXCL lock file
 *   (broken when older than 30 s) so separate processes sharing the directory do not interleave
 * - a corrupt file makes `get` throw rather than return null, so it can never be silently replaced
 */
export function fsVerdictStore(dir: string, opts: FsVerdictStoreOptions = {}): VerdictStore {
  const mutex = new KeyedMutex();

  async function readCurrent(file: string): Promise<{ verdict: Verdict; version: string } | null> {
    const raw = await readFileOrNull(file);
    if (raw === null) return null;
    return { verdict: parseEnvelope(raw, file).verdict, version: sha256(raw) };
  }

  return {
    async get(key) {
      return readCurrent(verdictFile(dir, key));
    },

    async put(v, expect) {
      const file = verdictFile(dir, v);
      return mutex.run(verdictKeyString(v), async () => {
        await mkdir(changeDir(dir, v.repo, v.number), { recursive: true });
        const release = await acquireFileLock(`${file}.lock`, opts.lock);
        try {
          const raw = await readFileOrNull(file);
          const currentVersion = raw === null ? null : sha256(raw);
          if (currentVersion !== expect.version) return { ok: false, version: currentVersion ?? "" };
          const envelope: Envelope = {
            schema: 1,
            nonce: randomUUID(),
            writtenAt: new Date().toISOString(),
            verdict: v,
          };
          const body = `${JSON.stringify(envelope, null, 2)}\n`;
          await atomicWrite(file, body);
          return { ok: true, version: sha256(body) };
        } finally {
          await release();
        }
      });
    },

    async listForChange(repo, number) {
      const cdir = changeDir(dir, repo, number);
      let names: string[];
      try {
        names = await readdir(cdir);
      } catch (err: unknown) {
        if (isErrno(err, "ENOENT")) return [];
        throw err;
      }
      const verdicts: Verdict[] = [];
      for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
        const found = await readCurrent(join(cdir, name));
        if (found) verdicts.push(found.verdict);
      }
      return verdicts.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    },
  };
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
