import { createReadStream } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CostEntry, CostLedger, RepoRef, SpendSummary } from "@merge-safely/core";
import {
  acquireFileLock,
  atomicWrite,
  encodeSegment,
  type FileLockOptions,
  isErrno,
  KeyedMutex,
  readFileOrNull,
} from "./io.js";
import {
  addEntry,
  inWindow,
  sameRepo,
  subtractTotals,
  type Totals,
  toSummary,
  usdToMicros,
  zeroTotals,
} from "./money.js";

/** One JSONL line: the entry as appended plus its exact integer micro-dollar amount. */
interface LedgerLine extends CostEntry {
  usdMicros: number;
  /** Parsed `at`; an unparseable timestamp is recorded at append time so spend never vanishes. */
  atMs: number;
}

interface RollupsFile {
  schema: 1;
  /** Per installation: the raw all-time totals at the moment of the last reset. */
  baselines: Record<string, Totals & { at: string }>;
}

export interface FsCostLedgerOptions {
  now?: () => Date;
  lock?: FileLockOptions;
}

/** File name for an installation's ledger; entries without one (or with an empty id) go to "_". Reads still filter by id. */
function ledgerFileName(installationId: string | undefined): string {
  return `${installationId ? encodeSegment(installationId) : "_"}.jsonl`;
}

/**
 * Filesystem CostLedger: append-only JSONL at `<dir>/ledger/<installationId or "_">.jsonl`,
 * reset baselines in `<dir>/ledger/rollups.json`. Sums stream the files and add integer micro-dollars,
 * so they are exact. A torn trailing line from a crash is skipped on read and fenced off on the next append.
 *
 * Reset semantics: `reset(id)` records the installation's current all-time totals as a baseline;
 * `allTime` reports spend above the baseline. Rows are never deleted, so `forChange` and `forWindow` are unaffected.
 */
export function fsCostLedger(dir: string, opts: FsCostLedgerOptions = {}): CostLedger {
  const now = opts.now ?? (() => new Date());
  const ledgerDir = join(dir, "ledger");
  const rollupsFile = join(ledgerDir, "rollups.json");
  const mutex = new KeyedMutex();

  async function* readLines(file: string): AsyncGenerator<LedgerLine> {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err: unknown) {
          void err;
          continue; // torn write from a crash; the rest of the file is still good
        }
        if (isLedgerLine(parsed)) yield parsed;
      }
    } catch (err: unknown) {
      if (isErrno(err, "ENOENT")) return;
      throw err;
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async function sumFiles(files: string[], pred: (e: LedgerLine) => boolean): Promise<Totals> {
    const t = zeroTotals();
    for (const f of files) for await (const e of readLines(f)) if (pred(e)) addEntry(t, e.usdMicros, e.tokens);
    return t;
  }

  async function allLedgerFiles(): Promise<string[]> {
    try {
      return (await readdir(ledgerDir)).filter((n) => n.endsWith(".jsonl")).map((n) => join(ledgerDir, n));
    } catch (err: unknown) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
  }

  const rawAllTime = (id: string) => sumFiles([join(ledgerDir, ledgerFileName(id))], (e) => e.installationId === id);

  async function readRollups(): Promise<RollupsFile> {
    const raw = await readFileOrNull(rollupsFile);
    if (raw === null) return { schema: 1, baselines: {} };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== 1) {
      throw new Error(`corrupt ledger rollups file ${rollupsFile}`);
    }
    return parsed as RollupsFile;
  }

  return {
    async append(entry: CostEntry) {
      const parsed = Date.parse(entry.at);
      const atMs = Number.isNaN(parsed) ? now().getTime() : parsed;
      const line: LedgerLine = { ...entry, usdMicros: usdToMicros(entry.usd), atMs };
      const file = join(ledgerDir, ledgerFileName(entry.installationId));
      await mutex.run(file, async () => {
        await mkdir(ledgerDir, { recursive: true });
        const fh = await open(file, "a+");
        try {
          // If a previous writer crashed mid-line, start on a fresh line so this entry is not glued to the torn one.
          const { size } = await fh.stat();
          let prefix = "";
          if (size > 0) {
            const last = Buffer.alloc(1);
            await fh.read(last, 0, 1, size - 1);
            if (last.toString("utf8") !== "\n") prefix = "\n";
          }
          await fh.write(`${prefix}${JSON.stringify(line)}\n`);
        } finally {
          await fh.close();
        }
      });
    },

    async forChange(repo: RepoRef, number: number): Promise<SpendSummary> {
      return toSummary(await sumFiles(await allLedgerFiles(), (e) => e.number === number && sameRepo(e.repo, repo)));
    },

    async forWindow(installationId: string, windowMs: number): Promise<SpendSummary> {
      const nowMs = now().getTime();
      const file = join(ledgerDir, ledgerFileName(installationId));
      return toSummary(
        await sumFiles([file], (e) => e.installationId === installationId && inWindow(e.atMs, nowMs, windowMs)),
      );
    },

    async allTime(installationId: string): Promise<SpendSummary> {
      const [raw, rollups] = await Promise.all([rawAllTime(installationId), readRollups()]);
      const base = rollups.baselines[installationId] ?? zeroTotals();
      return toSummary(subtractTotals(raw, base));
    },

    async reset(installationId: string) {
      await mutex.run(rollupsFile, async () => {
        await mkdir(ledgerDir, { recursive: true });
        const release = await acquireFileLock(`${rollupsFile}.lock`, opts.lock);
        try {
          const rollups = await readRollups();
          const raw = await rawAllTime(installationId);
          rollups.baselines[installationId] = { ...raw, at: now().toISOString() };
          await atomicWrite(rollupsFile, `${JSON.stringify(rollups, null, 2)}\n`);
        } finally {
          await release();
        }
      });
    },
  };
}

function isLedgerLine(v: unknown): v is LedgerLine {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<LedgerLine>;
  return (
    typeof o.usdMicros === "number" &&
    typeof o.atMs === "number" &&
    typeof o.number === "number" &&
    typeof o.at === "string" &&
    typeof o.repo === "object" &&
    o.repo !== null &&
    typeof o.tokens === "object" &&
    o.tokens !== null
  );
}
