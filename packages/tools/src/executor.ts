import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
import { createContext, runGit, type ToolContext } from "./ctx.js";
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  READ_ONLY_DEFINITIONS,
  runCommandDefinition,
  TOOL_NAMES,
} from "./definitions.js";
import { commandEnv, resolveBinary } from "./env.js";
import { ignoredPaths, isIgnored, listWorkspaceFiles, looksBinary, SKIP_DIRS } from "./files.js";
import { matchGlob } from "./glob.js";
import { PathError, realRootOf, resolveSafe, type SafePath } from "./paths.js";
import { runProcess } from "./proc.js";
import { redactDiagnostics, redactToolOutput } from "./redact.js";
import { type SearchEngine, search } from "./search.js";
import { hasGitSegment, isSensitivePath } from "./sensitive.js";
import { matchAllowlist, parseAllowEntry, tokenizeCommand } from "./tokenize.js";
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
  /** Known secret values (connection keys, tokens from the environment) removed verbatim from every output. */
  secrets?: readonly string[];
}

/** A model-facing failure: becomes `{ ok: false, output: "error: <message>" }`. */
class ToolError extends Error {}

interface Outcome {
  output: string;
  ok?: boolean;
  /** True when the call found nothing ("no matches", "no differences"): not proof of work. */
  empty?: boolean;
  /** Normalised identity of the call; repeats of the same key count once toward proof of work. */
  key?: string;
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

/** Revisions that reach git must never be parsed as options. */
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

/** Remove a scratch dir even if the command chmod'ed parts of it read-only. */
async function forceRemove(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // fall through: restore permissions and retry
  }
  const fix = async (d: string): Promise<void> => {
    try {
      await chmod(d, 0o700);
      for (const e of await readdir(d, { withFileTypes: true })) if (e.isDirectory()) await fix(join(d, e.name));
    } catch {
      // best effort
    }
  };
  await fix(dir);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export const createReadOnlyTools = ((ws: WorkspaceHandle, opts: ReadOnlyToolsOptions = {}): ToolExecutor => {
  const secrets = opts.secrets ?? [];
  const maxOutputBytes =
    opts.maxOutputBytes && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const commandTimeoutMs =
    opts.commandTimeoutMs && opts.commandTimeoutMs > 0 ? opts.commandTimeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
  const allowedCommands = (opts.allowedCommands ?? []).map((c) => c.trim()).filter((c) => parseAllowEntry(c));
  const searchEngine = opts.searchEngine ?? "auto";

  let ctx: ToolContext | undefined;
  let rootError: string | undefined;
  try {
    ctx = createContext(realRootOf(ws.cwd));
  } catch (e: unknown) {
    rootError = `workspace root is not accessible: ${errMessage(e)}`;
  }

  // Resolve every allowlisted command's executable once, from safe PATH dirs only, so a PR-committed
  // node_modules/.bin/<tool> can never shadow it. Explicit paths ("./scripts/test.sh") are the policy's choice.
  const commandBins = new Map<string, string>();
  if (ctx) {
    for (const raw of allowedCommands) {
      const entry = parseAllowEntry(raw);
      const tok = entry ? tokenizeCommand(entry.command) : undefined;
      const argv0 = tok?.ok ? tok.argv[0] : undefined;
      if (!argv0 || commandBins.has(argv0)) continue;
      if (argv0.includes("/")) {
        commandBins.set(argv0, isAbsolute(argv0) ? argv0 : join(ctx.realRoot, argv0));
      } else {
        const bin = resolveBinary(argv0, ctx.realRoot, ctx.pathDirs);
        if (bin) commandBins.set(argv0, bin);
      }
    }
  }

  const defs: ToolDefinition[] = [...READ_ONLY_DEFINITIONS];
  if (allowedCommands.length > 0) defs.push(runCommandDefinition(allowedCommands));
  const byName = new Map(defs.map((d) => [d.name, d]));

  let totalCalls = 0;
  const substantiveKeys = new Set<string>();
  const filesRead = new Set<string>();
  const commandsRun: string[] = [];

  const c = (): ToolContext => ctx as ToolContext;

  const git = async (args: string[], signal?: AbortSignal): Promise<string> => {
    const r = await runGit(c(), args, { timeoutMs: GIT_TIMEOUT_MS, maxBytes: maxOutputBytes * 2, signal });
    if (r.spawnError) throw new ToolError(`git failed to start: ${r.spawnError}`);
    if (r.timedOut) throw new ToolError(`git timed out after ${GIT_TIMEOUT_MS / 1000}s`);
    if (r.aborted) throw new ToolError("aborted");
    if (r.code !== 0) throw new ToolError(r.stderr.trim() || `git exited with code ${r.code}`);
    return r.stdout;
  };

  const resolveCommit = async (rev: string, signal?: AbortSignal): Promise<string> => {
    try {
      const sha = (
        await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], signal)
      ).trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
    } catch {
      // fall through
    }
    throw new ToolError(`unknown revision: ${rev}`);
  };

  /**
   * Refuse credential-shaped files in every mode, and untracked git-ignored files (a developer's
   * `.env`, local config, build output in `--local` mode). A fresh checkout has no ignored files.
   */
  const guardContent = async (p: SafePath, signal?: AbortSignal): Promise<void> => {
    if (isSensitivePath(p.rel) || isSensitivePath(p.realRel)) {
      throw new ToolError(`${p.rel} looks like a credentials file; it is never readable by reviewers`);
    }
    const ignored = await ignoredPaths(c(), signal);
    if (isIgnored(p.rel, ignored) || isIgnored(p.realRel, ignored)) {
      throw new ToolError(`${p.rel} is git-ignored and untracked; it is not part of the change and is not readable`);
    }
  };

  const handlers: Record<string, (input: Input, signal?: AbortSignal) => Promise<Outcome>> = {
    async [TOOL_NAMES.readFile](input, signal) {
      const p = resolveSafe(c().realRoot, reqString(input, "path"), { mustExist: true });
      const st = await stat(p.abs);
      if (st.isDirectory()) throw new ToolError(`${p.rel} is a directory; use list_dir`);
      if (!st.isFile()) throw new ToolError(`${p.rel} is not a regular file`);
      await guardContent(p, signal);
      if (st.size > MAX_READ_FILE_BYTES) throw new ToolError(`${p.rel} is too large (${st.size} bytes) to read`);
      const buf = await readFile(p.abs);
      if (looksBinary(buf)) {
        throw new ToolError(
          `${p.rel} contains NUL bytes (binary); refusing to read it. A source file containing NUL bytes is itself suspicious`,
        );
      }
      const offset = optInt(input, "offset", 1, Number.MAX_SAFE_INTEGER) ?? 1;
      const limit = optInt(input, "limit", 1, MAX_READ_LIMIT) ?? DEFAULT_READ_LIMIT;
      // Repeated reads of one file (any range) count once toward proof of work.
      const key = `read_file:${p.rel}`;
      if (buf.length === 0) return { output: `(${p.rel} is empty)`, filesRead: [p.rel], key, empty: true };
      const lines = buf.toString("utf8").split("\n");
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
      return { output: out.join("\n"), filesRead: [p.rel], key };
    },

    async [TOOL_NAMES.listDir](input, signal) {
      const p = resolveSafe(c().realRoot, optString(input, "path"), { mustExist: true });
      const depth = optInt(input, "depth", 1, 6) ?? 2;
      const st = await stat(p.abs);
      if (!st.isDirectory()) throw new ToolError(`${p.rel} is not a directory`);
      const ignored = await ignoredPaths(c(), signal);
      if (isIgnored(p.rel, ignored)) throw new ToolError(`${p.rel} is git-ignored and untracked`);
      const out: string[] = [p.rel === "." ? "./" : `${p.rel}/`];
      let count = 0;
      let capped = false;
      const visit = async (dir: string, rel: string, level: number): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
          const indent = "  ".repeat(level);
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
            out.push(`${indent}${e.name}/ (skipped)`);
            continue;
          }
          if (isSensitivePath(childRel) || isIgnored(childRel, ignored)) continue;
          if (count >= MAX_LIST_ENTRIES) {
            capped = true;
            return;
          }
          count++;
          if (e.isSymbolicLink()) {
            out.push(`${indent}${e.name}@ (symlink)`);
          } else if (e.isDirectory()) {
            out.push(`${indent}${e.name}/`);
            if (level < depth) await visit(join(dir, e.name), childRel, level + 1);
          } else {
            out.push(`${indent}${e.name}`);
          }
        }
      };
      await visit(p.abs, p.rel, 1);
      if (capped) out.push(`[stopped after ${MAX_LIST_ENTRIES} entries; list a subdirectory]`);
      return { output: out.join("\n") };
    },

    async [TOOL_NAMES.findFiles](input, signal) {
      const glob = reqString(input, "glob");
      const maxResults = optInt(input, "maxResults", 1, 2000) ?? 200;
      const key = `find_files:${JSON.stringify([glob, maxResults])}`;
      const all = await listWorkspaceFiles(c(), signal);
      const hits: string[] = [];
      let more = false;
      for (const f of all) {
        if (hasGitSegment(f) || !matchGlob(glob, f)) continue;
        if (hits.length >= maxResults) {
          more = true;
          break;
        }
        hits.push(f);
      }
      if (hits.length === 0) return { output: `no files match ${glob}`, empty: true, key };
      if (more) hits.push(`[more than ${maxResults} matches; narrow the glob]`);
      return { output: hits.join("\n"), key };
    },

    async [TOOL_NAMES.search](input, signal) {
      const pattern = reqString(input, "pattern");
      const p = resolveSafe(c().realRoot, optString(input, "path"), { mustExist: true });
      const st = await stat(p.abs);
      if (st.isFile()) await guardContent(p, signal);
      else if (isIgnored(p.rel, await ignoredPaths(c(), signal))) {
        throw new ToolError(`${p.rel} is git-ignored and untracked`);
      }
      const glob = optString(input, "glob");
      const params = {
        pattern,
        rel: p.rel,
        isFile: st.isFile(),
        ...(glob !== undefined ? { glob } : {}),
        maxResults: optInt(input, "maxResults", 1, 1000) ?? 200,
        ignoreCase: optBool(input, "ignoreCase"),
        literal: optBool(input, "literal"),
      };
      const key = `search:${JSON.stringify(params)}`;
      const res = await search(
        c(),
        { ...params, ...(opts.searchTimeoutMs !== undefined ? { timeoutMs: opts.searchTimeoutMs } : {}) },
        searchEngine,
        signal,
      );
      if (res.lines.length === 0) return { output: "no matches", empty: true, key };
      const lines = [...res.lines];
      if (res.more) lines.push("[more matches not shown; narrow the pattern, path or glob]");
      return { output: lines.join("\n"), key };
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
      const rel = pathIn !== undefined ? resolveSafe(c().realRoot, pathIn).rel : undefined;
      if (rel !== undefined) tail.push("--", rel);
      const key = `git_diff:${JSON.stringify([base, head ?? null, rel ?? null])}`;
      const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      let out: string;
      if (baseIn === undefined && head === undefined && ws.baseSha) {
        // The change under review: merge-base(base, HEAD) .. working tree, i.e. what the PR introduces.
        // If the merge base is unknown (shallow fetch, unrelated histories) say so rather than silently
        // showing a two-dot diff in which base-branch commits look reverted by the PR.
        try {
          out = await git([...common, "--merge-base", base, ...tail], signal);
        } catch (e: unknown) {
          throw new ToolError(
            `could not compute the merge base of the pull request base (${base.slice(0, 12)}) and HEAD: ${errMessage(e)}. ` +
              "The history may be shallow. Pass base and head explicitly for a direct comparison.",
          );
        }
      } else {
        out = await git([...common, base, ...(head ? [head] : []), ...tail], signal);
      }
      return out.trim() ? { output: out, key } : { output: "no differences", empty: true, key };
    },

    async [TOOL_NAMES.gitLog](input, signal) {
      const pathIn = optString(input, "path");
      const maxCount = optInt(input, "maxCount", 1, 200) ?? 20;
      const args = ["log", "--no-color", `--max-count=${maxCount}`, "--date=short", "--format=%h %ad %an%n    %s"];
      const rel = pathIn !== undefined ? resolveSafe(c().realRoot, pathIn).rel : undefined;
      if (rel !== undefined) args.push("--", rel);
      const key = `git_log:${JSON.stringify([rel ?? null, maxCount])}`;
      const out = await git(args, signal);
      return out.trim() ? { output: out, key } : { output: "no commits", empty: true, key };
    },

    async [TOOL_NAMES.gitBlame](input, signal) {
      const p = resolveSafe(c().realRoot, reqString(input, "path"), { mustExist: true });
      await guardContent(p, signal);
      const start = optInt(input, "startLine", 1, Number.MAX_SAFE_INTEGER);
      const end = optInt(input, "endLine", 1, Number.MAX_SAFE_INTEGER);
      if (start !== undefined && end !== undefined && end < start) throw new ToolError("endLine must be >= startLine");
      const args = ["blame", "--date=short"];
      if (start !== undefined || end !== undefined) args.push(`-L${start ?? 1},${end ?? ""}`);
      // Paths always follow "--", so a file named "-x.ts" is a path, not an option.
      args.push("--", p.rel);
      const out = await git(args, signal);
      const key = `git_blame:${JSON.stringify([p.rel, start ?? null, end ?? null])}`;
      return { output: out, filesRead: [p.rel], key, empty: out.trim() === "" };
    },

    async [TOOL_NAMES.runCommand](input, signal) {
      if (allowedCommands.length === 0) throw new ToolError("run_command is not enabled for this review");
      const command = reqString(input, "command").trim();
      if (!matchAllowlist(command, allowedCommands)) {
        throw new ToolError(`command is not allowlisted. Allowed: ${allowedCommands.join(", ")}`);
      }
      const tok = tokenizeCommand(command);
      if (!tok.ok) throw new ToolError(tok.error);
      const [argv0, ...args] = tok.argv as [string, ...string[]];
      const bin = commandBins.get(argv0);
      if (!bin) throw new ToolError(`${argv0} was not found on PATH (outside the checkout)`);
      // Per-call scratch HOME/TMPDIR: PR code never sees ~/.npmrc, ~/.ssh, ~/.config/gh or the runner's tmp.
      const scratch = await mkdtemp(join(tmpdir(), "merge-safely-cmd-"));
      const home = join(scratch, "home");
      const tmp = join(scratch, "tmp");
      await mkdir(home, { mode: 0o700 });
      await mkdir(tmp, { mode: 0o700 });
      try {
        const r = await runProcess(bin, args, {
          cwd: c().realRoot,
          env: commandEnv(c().pathDirs, { home, tmp }),
          timeoutMs: commandTimeoutMs,
          maxBytes: maxOutputBytes,
          ...(signal ? { signal } : {}),
        });
        if (r.spawnError) throw new ToolError(`could not start ${argv0}: ${r.spawnError}`);
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
        return {
          output: header + r.combined,
          commandRun: command,
          truncated: r.overflow,
          key: `run_command:${command}`,
        };
      } finally {
        await forceRemove(scratch);
      }
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
        // Redact before truncating so a cut never leaves half a secret visible. Precise mode: the reviewer
        // must see code as written, including code that handles credentials.
        const t = truncateOutput(redactToolOutput(o.output, secrets), maxOutputBytes, o.truncated === true);
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
        if (def.substantive && ok && !o.empty) substantiveKeys.add(o.key ?? `${def.name}:${JSON.stringify(input)}`);
        return result;
      } catch (e: unknown) {
        const msg = e instanceof ToolError || e instanceof PathError ? e.message : errMessage(e);
        return {
          ok: false,
          output: truncateOutput(redactDiagnostics(`error: ${msg}`, secrets), maxOutputBytes).output,
        };
      }
    },

    /**
     * Runner-observed proof of work.
     * - totalCalls: every execute() call, including failures.
     * - substantiveCalls: DISTINCT successful calls of substantive tools that returned content.
     *   "no matches", "no files match", "no commits", "no differences" and empty files do not count;
     *   repeats of the same normalised call count once (read_file counts once per file, whatever range).
     * - filesRead: unique workspace-relative paths whose content was shown (read_file, git_blame).
     * - commandsRun: every run_command actually spawned, in order (including timeouts).
     */
    audit(): Pick<ToolUseAudit, "substantiveCalls" | "totalCalls" | "filesRead" | "commandsRun"> {
      return {
        substantiveCalls: substantiveKeys.size,
        totalCalls,
        filesRead: [...filesRead],
        commandsRun: [...commandsRun],
      };
    },
  };
}) satisfies ToolExecutorFactory;
