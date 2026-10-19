import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolExecutorFactory,
  ToolExecutorOptions,
  ToolResult,
  ToolUseAudit,
  WorkspaceHandle,
} from "@merge-safely/core";
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  READ_ONLY_DEFINITIONS,
  runCommandDefinition,
  TOOL_NAMES,
} from "./definitions.js";
import { listWorkspaceFiles, looksBinary, SKIP_DIRS } from "./files.js";
import { matchGlob } from "./glob.js";
import { PathError, realRootOf, resolveSafe } from "./paths.js";
import { runProcess, scrubbedEnv } from "./proc.js";
import { type SearchEngine, search } from "./search.js";
import { matchAllowlist, tokenizeCommand } from "./tokenize.js";
import { truncateOutput } from "./truncate.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_LIST_ENTRIES = 1000;
/** Refs the model may pass to git: no leading dash, no whitespace or shell-ish characters. */
const REF_RE = /^[A-Za-z0-9._/~^@{}:+-]{1,200}$/;

/** Extra knobs beyond the core contract, mostly for tests. */
export interface ReadOnlyToolsOptions extends ToolExecutorOptions {
  /** "auto" (default) uses ripgrep when on PATH, otherwise the JS fallback. */
  searchEngine?: SearchEngine;
  searchTimeoutMs?: number;
}

/** A model-facing failure: becomes `{ ok: false, output: "error: <message>" }`. */
class ToolError extends Error {}

interface Outcome {
  output: string;
  ok?: boolean;
  truncated?: boolean;
  filesRead?: string[];
  commandRun?: string;
}

type Input = Record<string, unknown>;

function optString(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  return v;
}

function reqString(input: Input, key: string): string {
  const v = optString(input, key);
  if (v === undefined) throw new ToolError(`${key} is required`);
  return v;
}

function optInt(input: Input, key: string, min: number, max: number): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ToolError(`${key} must be an integer`);
  if (n < min) throw new ToolError(`${key} must be >= ${min}`);
  return Math.min(n, max);
}

function optBool(input: Input, key: string): boolean {
  const v = input[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be a boolean`);
  return v;
}

/** Arguments that reach git must never be parsed as options. */
function noOption(value: string, what: string): string {
  if (value.startsWith("-")) throw new ToolError(`${what} must not start with "-"`);
  return value;
}

function gitRef(value: string, what: string): string {
  noOption(value, what);
  if (!REF_RE.test(value)) throw new ToolError(`${what} is not a valid git revision`);
  return value;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const createReadOnlyTools = ((ws: WorkspaceHandle, opts: ReadOnlyToolsOptions = {}): ToolExecutor => {
  const maxOutputBytes =
    opts.maxOutputBytes && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const commandTimeoutMs =
    opts.commandTimeoutMs && opts.commandTimeoutMs > 0 ? opts.commandTimeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
  const allowedCommands = (opts.allowedCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  const searchEngine = opts.searchEngine ?? "auto";

  let realRoot: string | undefined;
  let rootError: string | undefined;
  try {
    realRoot = realRootOf(ws.cwd);
  } catch (e: unknown) {
    rootError = `workspace root is not accessible: ${errMessage(e)}`;
  }

  const defs: ToolDefinition[] = [...READ_ONLY_DEFINITIONS];
  if (allowedCommands.length > 0) defs.push(runCommandDefinition(allowedCommands));
  const byName = new Map(defs.map((d) => [d.name, d]));

  let totalCalls = 0;
  let substantiveCalls = 0;
  const filesRead = new Set<string>();
  const commandsRun: string[] = [];

  const git = async (args: string[], signal?: AbortSignal): Promise<string> => {
    const r = await runProcess(
      "git",
      ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "color.ui=never", ...args],
      {
        cwd: realRoot as string,
        env: scrubbedEnv({
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          // Paths are plain paths, never pathspec magic such as ":(top)" or globs.
          GIT_LITERAL_PATHSPECS: "1",
        }),
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: maxOutputBytes * 2,
        ...(signal ? { signal } : {}),
      },
    );
    if (r.spawnError) throw new ToolError(`git failed to start: ${r.spawnError}`);
    if (r.timedOut) throw new ToolError(`git timed out after ${GIT_TIMEOUT_MS / 1000}s`);
    if (r.aborted) throw new ToolError("aborted");
    if (r.code !== 0) throw new ToolError(r.stderr.trim() || `git exited with code ${r.code}`);
    return r.stdout;
  };

  const root = (): string => realRoot as string;

  const resolveCommit = async (rev: string, signal?: AbortSignal): Promise<string> => {
    try {
      const out = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], signal);
      const sha = out.trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
    } catch {
      // fall through
    }
    throw new ToolError(`unknown revision: ${rev}`);
  };

  const handlers: Record<string, (input: Input, signal?: AbortSignal) => Promise<Outcome>> = {
    async [TOOL_NAMES.readFile](input) {
      const p = resolveSafe(root(), reqString(input, "path"), { mustExist: true });
      const st = await stat(p.abs);
      if (st.isDirectory()) throw new ToolError(`${p.rel} is a directory; use list_dir`);
      if (!st.isFile()) throw new ToolError(`${p.rel} is not a regular file`);
      if (st.size > MAX_READ_FILE_BYTES) throw new ToolError(`${p.rel} is too large (${st.size} bytes) to read`);
      const buf = await readFile(p.abs);
      if (looksBinary(buf))
        throw new ToolError(
          `${p.rel} contains NUL bytes (binary); refusing to read it. A source file containing NUL bytes is itself suspicious`,
        );
      const offset = optInt(input, "offset", 1, Number.MAX_SAFE_INTEGER) ?? 1;
      const limit = optInt(input, "limit", 1, MAX_READ_LIMIT) ?? DEFAULT_READ_LIMIT;
      if (buf.length === 0) return { output: `(${p.rel} is empty)`, filesRead: [p.rel] };
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;
      if (offset > total) throw new ToolError(`offset ${offset} is past the end of ${p.rel} (${total} lines)`);
      const end = Math.min(total, offset + limit - 1);
      const out: string[] = [];
      for (let i = offset; i <= end; i++) {
        let line = (lines[i - 1] ?? "").replace(/\r$/, "");
        if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line cut]`;
        out.push(`${String(i).padStart(6)}\t${line}`);
      }
      if (end < total) {
        out.push(`[lines ${offset}-${end} of ${total}; call read_file with offset=${end + 1} to continue]`);
      }
      return { output: out.join("\n"), filesRead: [p.rel] };
    },

    async [TOOL_NAMES.listDir](input) {
      const p = resolveSafe(root(), optString(input, "path"), { mustExist: true });
      const depth = optInt(input, "depth", 1, 6) ?? 2;
      const st = await stat(p.abs);
      if (!st.isDirectory()) throw new ToolError(`${p.rel} is not a directory`);
      const out: string[] = [p.rel === "." ? "./" : `${p.rel}/`];
      let count = 0;
      let capped = false;
      const visit = async (dir: string, level: number): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (count >= MAX_LIST_ENTRIES) {
            capped = true;
            return;
          }
          count++;
          const indent = "  ".repeat(level);
          if (e.isSymbolicLink()) {
            out.push(`${indent}${e.name}@ (symlink)`);
          } else if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) {
              out.push(`${indent}${e.name}/ (skipped)`);
            } else {
              out.push(`${indent}${e.name}/`);
              if (level < depth) await visit(join(dir, e.name), level + 1);
            }
          } else {
            out.push(`${indent}${e.name}`);
          }
        }
      };
      await visit(p.abs, 1);
      if (capped) out.push(`[stopped after ${MAX_LIST_ENTRIES} entries; list a subdirectory]`);
      return { output: out.join("\n") };
    },

    async [TOOL_NAMES.findFiles](input, signal) {
      const glob = reqString(input, "glob");
      const maxResults = optInt(input, "maxResults", 1, 2000) ?? 200;
      const all = await listWorkspaceFiles(root(), signal);
      const hits: string[] = [];
      let more = false;
      for (const f of all) {
        if (!matchGlob(glob, f)) continue;
        if (hits.length >= maxResults) {
          more = true;
          break;
        }
        hits.push(f);
      }
      if (hits.length === 0) return { output: `no files match ${glob}` };
      if (more) hits.push(`[more than ${maxResults} matches; narrow the glob]`);
      return { output: hits.join("\n") };
    },

    async [TOOL_NAMES.search](input, signal) {
      const pattern = reqString(input, "pattern");
      const p = resolveSafe(root(), optString(input, "path"), { mustExist: true });
      const st = await stat(p.abs);
      const glob = optString(input, "glob");
      const res = await search(
        root(),
        {
          pattern,
          rel: p.rel,
          isFile: st.isFile(),
          ...(glob !== undefined ? { glob } : {}),
          maxResults: optInt(input, "maxResults", 1, 1000) ?? 200,
          ignoreCase: optBool(input, "ignoreCase"),
          literal: optBool(input, "literal"),
          ...(opts.searchTimeoutMs !== undefined ? { timeoutMs: opts.searchTimeoutMs } : {}),
        },
        searchEngine,
        signal,
      );
      if (res.lines.length === 0) return { output: "no matches" };
      const lines = [...res.lines];
      if (res.more) lines.push("[more matches not shown; narrow the pattern, path or glob]");
      return { output: lines.join("\n") };
    },

    async [TOOL_NAMES.gitDiff](input, signal) {
      const baseIn = optString(input, "base");
      const headIn = optString(input, "head");
      const pathIn = optString(input, "path");
      // Resolve revisions to commit SHAs first: a "revision" that is really a path outside the repo would
      // otherwise flip git diff into --no-index mode and read arbitrary files.
      const base = await resolveCommit(baseIn !== undefined ? gitRef(baseIn, "base") : (ws.baseSha ?? "HEAD"), signal);
      const head = headIn !== undefined ? await resolveCommit(gitRef(headIn, "head"), signal) : undefined;
      const tail: string[] = [];
      if (pathIn !== undefined) tail.push("--", noOption(resolveSafe(root(), pathIn).rel, "path"));
      const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      let out: string;
      if (baseIn === undefined && head === undefined && ws.baseSha) {
        // The change under review: merge-base(base, HEAD) .. working tree, i.e. what the PR introduces.
        try {
          out = await git([...common, "--merge-base", base, ...tail], signal);
        } catch {
          out = await git([...common, base, ...tail], signal);
        }
      } else {
        out = await git([...common, base, ...(head ? [head] : []), ...tail], signal);
      }
      return { output: out.trim() ? out : "no differences" };
    },

    async [TOOL_NAMES.gitLog](input, signal) {
      const pathIn = optString(input, "path");
      const maxCount = optInt(input, "maxCount", 1, 200) ?? 20;
      const args = ["log", "--no-color", `--max-count=${maxCount}`, "--date=short", "--format=%h %ad %an%n    %s"];
      if (pathIn !== undefined) args.push("--", noOption(resolveSafe(root(), pathIn).rel, "path"));
      const out = await git(args, signal);
      return { output: out.trim() ? out : "no commits" };
    },

    async [TOOL_NAMES.gitBlame](input, signal) {
      const p = resolveSafe(root(), reqString(input, "path"), { mustExist: true });
      noOption(p.rel, "path");
      const start = optInt(input, "startLine", 1, Number.MAX_SAFE_INTEGER);
      const end = optInt(input, "endLine", 1, Number.MAX_SAFE_INTEGER);
      if (start !== undefined && end !== undefined && end < start) throw new ToolError("endLine must be >= startLine");
      const args = ["blame", "--date=short"];
      if (start !== undefined || end !== undefined) args.push(`-L${start ?? 1},${end ?? ""}`);
      args.push("--", p.rel);
      return { output: await git(args, signal), filesRead: [p.rel] };
    },

    async [TOOL_NAMES.runCommand](input, signal) {
      if (allowedCommands.length === 0) throw new ToolError("run_command is not enabled for this review");
      const command = reqString(input, "command").trim();
      const entry = matchAllowlist(command, allowedCommands);
      if (!entry) throw new ToolError(`command is not allowlisted. Allowed: ${allowedCommands.join(", ")}`);
      const tok = tokenizeCommand(command);
      if (!tok.ok) throw new ToolError(tok.error);
      const [bin, ...args] = tok.argv as [string, ...string[]];
      const r = await runProcess(bin, args, {
        cwd: root(),
        env: scrubbedEnv(),
        timeoutMs: commandTimeoutMs,
        maxBytes: maxOutputBytes,
        ...(signal ? { signal } : {}),
      });
      if (r.spawnError) throw new ToolError(`could not start ${bin}: ${r.spawnError}`);
      if (r.timedOut) {
        return {
          ok: false,
          output: `error: command timed out after ${commandTimeoutMs}ms and was killed\n${r.combined}`,
          commandRun: command,
          truncated: r.overflow,
        };
      }
      if (r.aborted) return { ok: false, output: "error: aborted", commandRun: command };
      const header = `$ ${command}\nexit code: ${r.code ?? "killed"}\n`;
      return { output: header + r.combined, commandRun: command, truncated: r.overflow };
    },
  };

  return {
    definitions: () => defs.map((d) => ({ ...d, inputSchema: structuredClone(d.inputSchema) })),

    async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
      totalCalls++;
      try {
        if (rootError) throw new ToolError(rootError);
        if (signal?.aborted) throw new ToolError("aborted");
        const def = typeof call?.name === "string" ? byName.get(call.name) : undefined;
        const handler = def ? handlers[def.name] : undefined;
        if (!def || !handler) {
          throw new ToolError(
            `unknown tool ${JSON.stringify(call?.name)}. Available: ${defs.map((d) => d.name).join(", ")}`,
          );
        }
        const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : {};
        const o = await handler(input, signal);
        const ok = o.ok ?? true;
        const t = truncateOutput(o.output, maxOutputBytes, o.truncated === true);
        const result: ToolResult = { ok, output: t.output };
        if (t.truncated) result.truncated = true;
        if (o.filesRead && ok) {
          result.filesRead = o.filesRead;
          for (const f of o.filesRead) filesRead.add(f);
        }
        if (o.commandRun) {
          result.commandRun = o.commandRun;
          commandsRun.push(o.commandRun);
        }
        // Only calls that did real work count toward proof of work; failing calls cannot pad the audit.
        if (def.substantive && ok) substantiveCalls++;
        return result;
      } catch (e: unknown) {
        const msg = e instanceof ToolError || e instanceof PathError ? e.message : errMessage(e);
        return { ok: false, output: truncateOutput(`error: ${msg}`, maxOutputBytes).output };
      }
    },

    audit(): Pick<ToolUseAudit, "substantiveCalls" | "totalCalls" | "filesRead" | "commandsRun"> {
      return { substantiveCalls, totalCalls, filesRead: [...filesRead], commandsRun: [...commandsRun] };
    },
  };
}) satisfies ToolExecutorFactory;
