import { lstat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Worker } from "node:worker_threads";
import { runGit, type ToolContext } from "./ctx.js";
import { listWorkspaceFiles } from "./files.js";
import { matchGlob } from "./glob.js";
import { runProcess } from "./proc.js";
import { isHiddenPath, SENSITIVE_RG_GLOBS } from "./sensitive.js";

export interface SearchParams {
  pattern: string;
  /** Workspace-relative path (file or directory), already validated. "." for the root. */
  rel: string;
  isFile: boolean;
  glob?: string;
  maxResults: number;
  ignoreCase: boolean;
  literal: boolean;
  /** Hard wall-clock limit; defaults to 60s. */
  timeoutMs?: number;
}

export interface SearchOutcome {
  lines: string[];
  /** True when more matches existed than maxResults. */
  more: boolean;
}

export const MAX_LINE_CHARS = 300;
const SEARCH_TIMEOUT_MS = 60_000;
/** Same cap as read_file, so search never silently skips a file the model could read. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type SearchEngine = "auto" | "rg" | "js";

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

export async function search(
  ctx: ToolContext,
  p: SearchParams,
  engine: SearchEngine,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  if (engine === "rg" && !ctx.rgBin) throw new Error("ripgrep is not installed");
  const useRg = engine === "rg" || (engine === "auto" && ctx.rgBin !== undefined);
  const res = useRg ? await searchRg(ctx, p, signal) : await searchJs(ctx, p, signal);
  // Defence in depth: whatever the engine did, never surface .git internals or credential files.
  const lines = res.lines.filter((l) => {
    const m = /^(.*?):\d+: /.exec(l);
    return !m || !isHiddenPath(m[1] as string);
  });
  return { lines, more: res.more };
}

async function searchRg(ctx: ToolContext, p: SearchParams, signal?: AbortSignal): Promise<SearchOutcome> {
  const realRoot = ctx.realRoot;
  const args = [
    "--no-config",
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color=never",
    "--null",
    "--hidden",
    "--no-ignore-dot",
    "--no-ignore-global",
    "--no-ignore-exclude",
    `--max-filesize=${MAX_FILE_BYTES}`,
  ];
  if (p.ignoreCase) args.push("--ignore-case");
  if (p.literal) args.push("--fixed-strings");
  if (p.glob) args.push(`--glob=${p.glob}`);
  // In rg the LAST matching glob wins, so the exclusions must come after the model's glob.
  args.push("--iglob=!.git", "--iglob=!**/.git/**", ...SENSITIVE_RG_GLOBS.map((g) => `--iglob=${g}`));
  args.push(`--regexp=${p.pattern}`, "--", p.rel);
  if (!p.isFile) args.push(...(await trackedButIgnored(ctx, p, signal)));
  const r = await runProcess(ctx.rgBin as string, args, {
    cwd: realRoot,
    env: { PATH: ctx.pathDirs.join(delimiter) },
    timeoutMs: p.timeoutMs ?? SEARCH_TIMEOUT_MS,
    maxBytes: 8 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (r.spawnError) throw new Error(`rg failed to start: ${r.spawnError}`);
  if (r.timedOut)
    throw new Error(`search timed out after ${(p.timeoutMs ?? SEARCH_TIMEOUT_MS) / 1000}s; narrow the path or glob`);
  if (r.aborted) throw new Error("search aborted");
  if (r.code === 1) return { lines: [], more: false };
  if (r.code !== 0) throw new Error(r.stderr.trim() || `rg exited with code ${r.code}`);
  const lines: string[] = [];
  let more = r.overflow;
  for (const raw of r.stdout.split("\n")) {
    if (!raw) continue;
    const nul = raw.indexOf("\0");
    if (nul < 0) continue;
    const file = raw.slice(0, nul).replace(/^\.\//, "");
    const rest = raw.slice(nul + 1);
    const colon = rest.indexOf(":");
    if (colon < 0) continue;
    if (lines.length >= p.maxResults) {
      more = true;
      break;
    }
    lines.push(`${file}:${rest.slice(0, colon)}: ${clip(rest.slice(colon + 1))}`);
  }
  return { lines, more };
}

/**
 * ripgrep honours .gitignore patterns even for files git tracks, so a change could force-add a file and
 * then ignore it to hide it from search. Tracked-but-ignored files are passed to rg explicitly
 * (explicit paths bypass ignore rules). Per-directory .ignore/.rgignore files are disabled by flags.
 */
async function trackedButIgnored(ctx: ToolContext, p: SearchParams, signal?: AbortSignal): Promise<string[]> {
  const realRoot = ctx.realRoot;
  const r = await runGit(ctx, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: 8 * 1024 * 1024,
    signal,
  });
  if (r.code !== 0 || r.spawnError) return [];
  const prefix = p.rel === "." ? "" : `${p.rel.replace(/\/+$/, "")}/`;
  const g = p.glob;
  const out: string[] = [];
  for (const f of r.stdout.split("\0")) {
    if (out.length >= 5000) break;
    if (f.length === 0 || !f.startsWith(prefix) || isHiddenPath(f) || (g && !matchGlob(g, f))) continue;
    // rg follows explicitly named symlinks, so only plain files are passed.
    try {
      if ((await lstat(join(realRoot, f))).isFile()) out.push(f);
    } catch {
      // deleted in the working tree
    }
  }
  return out;
}

/**
 * Pure-JS fallback. Regex matching runs in a worker thread with a hard timeout so a catastrophic
 * (ReDoS) pattern from the model cannot hang the runner's event loop.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { root, files, source, flags, maxResults, maxLineChars, maxFileBytes } = workerData;
const re = new RegExp(source, flags);
const lines = [];
let more = false;
outer: for (const rel of files) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { continue; }
  if (!st.isFile() || st.size > maxFileBytes) continue;
  let real;
  try { real = fs.realpathSync(abs); } catch { continue; }
  if (!real.startsWith(root + path.sep)) continue;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const text = buf.toString("utf8").split("\\n");
  for (let i = 0; i < text.length; i++) {
    const line = text[i].replace(/\\r$/, "");
    if (re.test(line)) {
      if (lines.length >= maxResults) { more = true; break outer; }
      const shown = line.length > maxLineChars ? line.slice(0, maxLineChars) + "\\u2026" : line;
      lines.push(rel + ":" + (i + 1) + ": " + shown);
    }
  }
}
parentPort.postMessage({ lines, more });
`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchJs(ctx: ToolContext, p: SearchParams, signal?: AbortSignal): Promise<SearchOutcome> {
  const realRoot = ctx.realRoot;
  const source = p.literal ? escapeRegExp(p.pattern) : p.pattern;
  const flags = p.ignoreCase ? "i" : "";
  try {
    new RegExp(source, flags);
  } catch (e: unknown) {
    throw new Error(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  let files: string[];
  if (p.isFile) {
    files = [p.rel];
  } else {
    const all = await listWorkspaceFiles(ctx, signal);
    const prefix = p.rel === "." ? "" : `${p.rel.replace(/\/+$/, "")}/`;
    files = all.filter((f) => f.startsWith(prefix));
  }
  if (p.glob) {
    const g = p.glob;
    files = files.filter((f) => matchGlob(g, f));
  }
  return new Promise<SearchOutcome>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        root: realRoot,
        files,
        source,
        flags,
        maxResults: p.maxResults,
        maxLineChars: MAX_LINE_CHARS,
        maxFileBytes: MAX_FILE_BYTES,
      },
      env: {},
    });
    let done = false;
    const end = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        end(() =>
          reject(
            new Error(`search timed out after ${(p.timeoutMs ?? SEARCH_TIMEOUT_MS) / 1000}s; simplify the pattern`),
          ),
        ),
      p.timeoutMs ?? SEARCH_TIMEOUT_MS,
    );
    const onAbort = (): void => end(() => reject(new Error("search aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (m: SearchOutcome) => end(() => resolve(m)));
    worker.once("error", (e: Error) => end(() => reject(e)));
    worker.once("exit", (code) => end(() => reject(new Error(`search worker exited with code ${code}`))));
  });
}
