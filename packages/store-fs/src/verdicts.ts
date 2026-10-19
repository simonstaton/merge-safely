import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RepoRef, Verdict, VerdictKey, VerdictStore } from "@merge-safely/core";
import {
  acquireFileLock,
  atomicCreate,
  atomicWrite,
  encodeSegment,
  type FileLockOptions,
  isErrno,
  KeyedMutex,
  readFileOrNull,
} from "./io.js";
import { compareVerdicts, normaliseRepo, verdictKeyString } from "./key.js";

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

/** Path segments are lower-cased (GitHub names are case-insensitive) and percent-encoded. */
function changeDir(root: string, repo: RepoRef, number: number): string {
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("change number must be a non-negative integer");
  const r = normaliseRepo(repo);
  return join(root, "verdicts", encodeSegment(r.host), encodeSegment(r.owner), encodeSegment(r.name), String(number));
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
 * `<dir>/verdicts/<host>/<owner>/<name>/<number>/<sha>.json` (segments lower-cased; original casing kept inside).
 *
 * - version = sha256 of the file's bytes (each write carries a fresh nonce, so versions never repeat)
 * - creates commit with link(), which fails atomically if the file exists; replaces use temp + fsync + rename;
 *   the directory is fsynced after either
 * - compare-and-set is serialised by an in-process mutex per key and a `<file>.lock` lock file
 *   (see acquireFileLock); the holder re-verifies its lock token immediately before committing
 * - a corrupt file makes `get` throw rather than return null, so it can never be silently replaced
 */
export function fsVerdictStore(dir: string, opts: FsVerdictStoreOptions = {}): VerdictStore {
  const mutex = new KeyedMutex();

  async function readCurrent(file: string): Promise<{ verdict: Verdict; version: string } | null> {
    const raw = await readFileOrNull(file);
    if (raw === null) return null;
    return { verdict: parseEnvelope(raw, file).verdict, version: sha256(raw) };
  }

  const versionOf = async (file: string) => {
    const raw = await readFileOrNull(file);
    return raw === null ? null : sha256(raw);
  };

  return {
    async get(key) {
      return readCurrent(verdictFile(dir, key));
    },

    async put(v, expect) {
      const file = verdictFile(dir, v);
      return mutex.run(verdictKeyString(v), async () => {
        await mkdir(changeDir(dir, v.repo, v.number), { recursive: true });
        const lock = await acquireFileLock(`${file}.lock`, opts.lock);
        try {
          const currentVersion = await versionOf(file);
          if (currentVersion !== expect.version) return { ok: false, version: currentVersion ?? "" };
          const envelope: Envelope = {
            schema: 1,
            nonce: randomUUID(),
            writtenAt: new Date().toISOString(),
            verdict: v,
          };
          const body = `${JSON.stringify(envelope, null, 2)}\n`;
          if (!(await lock.verify())) throw new Error(`lost lock on ${file} before commit; retry`);
          if (expect.version === null) {
            if (!(await atomicCreate(file, body))) return { ok: false, version: (await versionOf(file)) ?? "" };
          } else {
            await atomicWrite(file, body);
          }
          return { ok: true, version: sha256(body) };
        } finally {
          await lock.release();
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
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const found = await readCurrent(join(cdir, name));
        if (found) verdicts.push(found.verdict);
      }
      return verdicts.sort(compareVerdicts);
    },
  };
}
