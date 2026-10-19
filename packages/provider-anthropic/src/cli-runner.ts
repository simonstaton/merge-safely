import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Connection,
  classifyRunnerExit,
  extractJson,
  type ModelInfo,
  type ModelRunner,
  type ReviewerInput,
  type ReviewerRun,
  type RunnerOptions,
  type RunStatus,
  type Seat,
  type TokenUsage,
  type ToolUseAudit,
  type WorkspaceHandle,
} from "@merge-safely/core";
import { priceFor } from "./models.js";
import { buildRun, outputSchemaFor, type ParsedOutput, parseForSeat } from "./output.js";
import { envSecretValues, secretValues } from "./secrets.js";
import { StreamJsonParser } from "./stream-json.js";

export interface ClaudeCodeRunnerConfig {
  /** Path or name of the Claude Code binary. Default "claude" (resolved on PATH). */
  binary?: string;
  /** Grace between SIGTERM and SIGKILL on deadline. Default 5000ms. */
  killGraceMs?: number;
  /** Extra variable names copied from the gate's environment (e.g. a corporate proxy). Never credentials. */
  envPassthrough?: string[];
  /** Environment to copy allowlisted variables from. Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Compiled `ms-git` wrapper (dist/git-wrapper.js). Default: next to this module. */
  gitWrapperPath?: string;
  /** Node binary used to run the wrapper. Default process.execPath. */
  nodePath?: string;
}

/** The only git the model gets: a wrapper that allows diff/log/blame/show with vetted arguments. */
export const GIT_WRAPPER_COMMAND = "ms-git";
/** Built-ins available to the reviewer. Write tools, web and sub-agents are denied outright. */
export const CLI_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export const CLI_READ_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;
export const CLI_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Bash(git:*)",
] as const;

/** Variables a CLI needs to run at all. Everything else, credentials included, is dropped. */
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;
/** The user's home and config locations: copied only for subscription connections (the login lives there). */
const HOME_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"] as const;

/** Privacy flags verified in the Claude Code binary: no telemetry, error reporting, auto-update or other phone-home. */
const PRIVACY_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
};

const SAFE_COMMAND = /^[A-Za-z0-9 ._/=:@+-]+$/;
/** A bare interpreter or shell as an allowed command would allow arbitrary code: `Bash(node:*)` runs anything. */
const INTERPRETERS =
  /^(sh|bash|zsh|dash|ksh|fish|node|nodejs|deno|bun|python[0-9.]*|perl|ruby|php|env|xargs|eval|exec|find|sudo|su|awk|gawk|sed|nohup|timeout|nice|command|busybox)$/;

/** Allowed-tools list: read tools, the git wrapper, plus one Bash(<cmd>:*) per policy-allowed command. */
export function cliAllowedTools(
  allowedCommands: readonly string[],
  onRejected?: (cmd: string, why: string) => void,
): string[] {
  const out: string[] = [...CLI_READ_TOOLS, `Bash(${GIT_WRAPPER_COMMAND}:*)`];
  for (const raw of allowedCommands) {
    const cmd = raw.trim().replace(/\s+/g, " ");
    // Parentheses, commas, globs or shell metacharacters would widen or break the permission rule.
    if (!cmd || !SAFE_COMMAND.test(cmd)) {
      onRejected?.(raw, "unsafe characters");
      continue;
    }
    const first = cmd.split(" ")[0] ?? "";
    if (!cmd.includes(" ") && INTERPRETERS.test(first)) {
      onRejected?.(raw, "a bare interpreter or shell would allow arbitrary code");
      continue;
    }
    if (first === "git" || first === GIT_WRAPPER_COMMAND) {
      onRejected?.(raw, `raw git is never exposed; reviewers use ${GIT_WRAPPER_COMMAND}`);
      continue;
    }
    const rule = `Bash(${cmd}:*)`;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

export interface CliSandboxDirs {
  /** Prepended to PATH; holds the `ms-git` launcher. */
  binDir?: string;
  /** Temporary empty HOME for non-subscription connections. */
  home?: string;
}

/**
 * Child environment: a scrubbed allowlist plus exactly the credential the connection kind dictates. For every kind
 * except subscription, HOME/XDG/CLAUDE_CONFIG_DIR point into an empty temp dir so no host credentials are readable.
 */
export function buildCliEnv(
  conn: Connection,
  cfg: ClaudeCodeRunnerConfig = {},
  dirs: CliSandboxDirs = {},
): Record<string, string> {
  const src = cfg.baseEnv ?? process.env;
  const subscription = conn.secret.kind === "subscription";
  const names = [...BASE_ENV_ALLOWLIST, ...(subscription ? HOME_ENV : []), ...(cfg.envPassthrough ?? [])];
  const env: Record<string, string> = {};
  for (const k of names) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) continue; // credentials only ever come from the connection
    if (!subscription && (HOME_ENV as readonly string[]).includes(k)) continue;
    const v = src[k];
    if (typeof v === "string") env[k] = v;
  }
  if (dirs.binDir) env.PATH = env.PATH ? `${dirs.binDir}${delimiter}${env.PATH}` : dirs.binDir;
  if (!subscription && dirs.home) {
    env.HOME = dirs.home;
    env.USERPROFILE = dirs.home;
    env.XDG_CONFIG_HOME = join(dirs.home, ".config");
    env.XDG_CACHE_HOME = join(dirs.home, ".cache");
    env.XDG_DATA_HOME = join(dirs.home, ".local", "share");
    env.XDG_STATE_HOME = join(dirs.home, ".local", "state");
    env.CLAUDE_CONFIG_DIR = join(dirs.home, ".claude");
  }
  Object.assign(env, PRIVACY_ENV);
  const s = conn.secret;
  switch (s.kind) {
    case "api-key":
      env.ANTHROPIC_API_KEY = s.apiKey;
      break;
    case "anthropic-compatible": {
      env.ANTHROPIC_BASE_URL = s.baseUrl;
      if (conn.options?.authHeader === "bearer") env.ANTHROPIC_AUTH_TOKEN = s.apiKey;
      else env.ANTHROPIC_API_KEY = s.apiKey;
      const headers = Object.entries(s.headers ?? {});
      if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.map(([k, v]) => `${k}: ${v}`).join("\n");
      break;
    }
    case "oauth":
      if (conn.options?.oauthEnv === "claude-code") env.CLAUDE_CODE_OAUTH_TOKEN = s.accessToken;
      else env.ANTHROPIC_AUTH_TOKEN = s.accessToken;
      break;
    case "subscription":
      // The user's own Claude Code login. Nothing is injected; an explicit config dir may be named.
      if (s.credentialFileRef) env.CLAUDE_CONFIG_DIR = s.credentialFileRef;
      break;
    default:
      break;
  }
  return env;
}

const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Write the `ms-git` launcher: pins MS_GIT_CWD to the workspace and execs the compiled wrapper with node. */
export function writeGitLauncher(binDir: string, cwd: string, wrapperPath: string, nodePath: string): string {
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, GIT_WRAPPER_COMMAND);
  writeFileSync(
    launcher,
    `#!/bin/sh\nMS_GIT_CWD=${shQuote(cwd)} exec ${shQuote(nodePath)} ${shQuote(wrapperPath)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

const BUDGET_SUBTYPE = /max_turns|budget/;

function systemPrompt(seat: Seat, input: ReviewerInput): string {
  return [
    input.prompt.system,
    "",
    "## How to work",
    "You are a read-only reviewer inside a checkout of the change's head commit. Never modify files.",
    "Investigate with Read, Grep and Glob (confined to this checkout) and, for history, the `ms-git` command:",
    "`ms-git diff|log|blame|show [revisions] [--stat|-p|--oneline|-n<N>|-U<N>|-L<a>,<b>|--name-only|--name-status|--follow] [-- paths]`.",
    "Plain `git` is not available.",
    "",
    "## Output",
    `When finished, return your final ${seat.role === "judge" ? "votes" : "review"} as structured output matching the provided JSON schema.`,
    "If structured output is unavailable, reply with only a single JSON object matching the schema, with no prose.",
  ].join("\n");
}

/**
 * Claude Code CLI runner: `claude -p` in print mode with stream-json output, --safe-mode (no CLAUDE.md, skills,
 * hooks, plugins or MCP), --restricted (file tools confined to the checkout), a replaced system prompt, read-only
 * allowlisted tools, the `ms-git` wrapper instead of git, and the seat's JSON schema. The audit is built from the
 * CLI's own tool events. Usage arrives with the final result event (the CLI does not stream per-turn cost), so
 * onUsage fires once per run.
 */
export class ClaudeCodeRunner implements ModelRunner {
  private readonly secrets: string[];
  private readonly binary: string;
  private readonly killGraceMs: number;

  constructor(
    private readonly conn: Connection,
    private readonly model: ModelInfo,
    private readonly opts: RunnerOptions = {},
    private readonly cfg: ClaudeCodeRunnerConfig = {},
  ) {
    this.secrets = [...secretValues(conn), ...envSecretValues(cfg.baseEnv ?? process.env)];
    const fromConn = typeof conn.options?.claudeBinary === "string" ? conn.options.claudeBinary : undefined;
    this.binary = cfg.binary ?? fromConn ?? "claude";
    this.killGraceMs = cfg.killGraceMs ?? 5000;
  }

  private get planIncluded(): boolean {
    return this.model.zeroCost === true || this.conn.secret.kind === "subscription";
  }

  private effortFor(seat: Seat): string | undefined {
    const e = seat.model.effort;
    if (!e) return undefined;
    if (this.model.effortLevels?.includes(e)) return e;
    this.opts.logger?.warn("anthropic-cli: effort not supported by this model; omitted", {
      model: this.model.name,
      effort: e,
    });
    return undefined;
  }

  buildArgs(seat: Seat, input: ReviewerInput): string[] {
    const allowed = cliAllowedTools(input.allowedCommands, (cmd, why) =>
      this.opts.logger?.warn(`anthropic-cli: allowed command rejected (${why})`, { command: cmd }),
    );
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.model.name,
      "--max-turns",
      String(seat.budget.maxTurns),
      // No CLAUDE.md, skills, hooks, plugins, MCP or custom agents from the checkout or the host; auth still works.
      "--safe-mode",
      // File tools confined to the working directory; settings files ignored.
      "--restricted",
      "--tools",
      CLI_TOOLS.join(","),
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      CLI_DISALLOWED_TOOLS.join(","),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--json-schema",
      JSON.stringify(outputSchemaFor(seat, input)),
      // Replace, not append: the default prompt embeds git status (branch name, commit subjects) outside the data block.
      "--system-prompt",
      systemPrompt(seat, input),
    ];
    const effort = this.effortFor(seat);
    if (effort) args.push("--effort", effort);
    if (seat.budget.maxUsd !== undefined && !this.planIncluded) {
      args.push("--max-budget-usd", String(seat.budget.maxUsd));
    }
    return args;
  }

  async run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle, signal?: AbortSignal): Promise<ReviewerRun> {
    const startedAt = new Date();
    const t0 = Date.now();
    const parser = new StreamJsonParser(ws.cwd);
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let sandbox: string | undefined;

    if (signal?.aborted) aborted = true;
    else if (!existsSync(ws.cwd)) spawnError = `workspace directory does not exist: ${ws.cwd}`;
    else {
      try {
        sandbox = mkdtempSync(join(tmpdir(), "ms-claude-"));
        const binDir = join(sandbox, "bin");
        const wrapper = this.cfg.gitWrapperPath ?? fileURLToPath(new URL("./git-wrapper.js", import.meta.url));
        writeGitLauncher(binDir, ws.cwd, wrapper, this.cfg.nodePath ?? process.execPath);
        let home: string | undefined;
        if (this.conn.secret.kind !== "subscription") {
          home = join(sandbox, "home");
          mkdirSync(join(home, ".claude"), { recursive: true });
        }
        const env = buildCliEnv(this.conn, this.cfg, { binDir, ...(home ? { home } : {}) });
        const args = this.buildArgs(seat, input);
        [exitCode, exitSignal] = await this.spawnAndWait(args, ws.cwd, env, input.prompt.user, parser, seat, signal, {
          onStderr: (d) => {
            stderr = (stderr + d).slice(-8192);
          },
          onTimeout: () => {
            timedOut = true;
          },
          onAbort: () => {
            aborted = true;
          },
          onSpawnError: (m) => {
            spawnError = m;
          },
        });
      } catch (err: unknown) {
        spawnError = err instanceof Error ? err.message : String(err);
      } finally {
        if (sandbox) rmSync(sandbox, { recursive: true, force: true });
      }
    }

    const result = parser.result;
    // Usage: the result event's totals; if the process died first, the per-message usage it streamed.
    const tokens: TokenUsage = result?.usage ?? parser.streamedUsage();
    let usd: number | undefined;
    if (this.planIncluded) usd = 0;
    else if (result?.totalCostUsd !== undefined) usd = result.totalCostUsd;
    else {
      const priced = priceFor(this.model, tokens);
      usd = priced.usd;
      if (priced.estimated && (tokens.in || tokens.out)) {
        this.opts.logger?.warn("anthropic-cli: cost estimated at the pessimistic rate (no CLI total, model unpriced)", {
          model: this.model.name,
          seat: seat.id,
        });
      }
    }
    if (tokens.in || tokens.out || tokens.cachedIn || tokens.cacheWrite) {
      this.opts.onUsage?.({ tokens, usd });
    }

    const audit: ToolUseAudit = {
      ...parser.audit(),
      tokens,
      wallMs: Date.now() - t0,
      turns: parser.turns(),
      costUsd: usd,
    };

    let status: RunStatus;
    let error: string | undefined;
    let parsed: ParsedOutput | undefined;
    if (aborted && !timedOut) {
      status = "error";
      error = "run aborted by caller";
    } else if (spawnError && !result) {
      status = "error";
      error = spawnError;
    } else {
      const c = classifyRunnerExit({
        exitCode,
        signal: exitSignal,
        stderr,
        budgetFlagSet: true,
        ...(result?.subtype && BUDGET_SUBTYPE.test(result.subtype) ? { budgetSubtype: result.subtype } : {}),
        usage: { turns: audit.turns, ...(!this.planIncluded ? { usd } : {}) },
        caps: {
          maxTurns: seat.budget.maxTurns,
          deadlineMs: seat.budget.deadlineMs,
          ...(seat.budget.maxUsd !== undefined ? { maxUsd: seat.budget.maxUsd } : {}),
        },
        wallMs: audit.wallMs,
        timedOut,
      });
      status = c.status;
      error = c.recovery ? `${c.reason} ${c.recovery}` : c.reason;
      if (status === "error" && result?.subtype && /structured_output/.test(result.subtype) && !exitSignal) {
        status = "schema-invalid";
        error = `claude CLI could not produce schema-valid output (${result.subtype})`;
      } else if (status === "ok") {
        // A clean exit (code 0, no signal) is required before a result event is trusted.
        error = undefined;
        if (!result) {
          status = "error";
          error = parser.resultSuperseded
            ? "claude CLI result event was followed by more output; discarded"
            : "claude CLI exited without a result event";
        } else if (result.isError) {
          status = "error";
          error = `claude CLI reported ${result.subtype ?? "an error"}`;
        } else {
          const raw = result.structuredOutput ?? extractJson(result.resultText ?? "");
          if (raw === undefined) {
            status = "schema-invalid";
            error = "claude CLI returned no JSON output";
          } else {
            parsed = parseForSeat(seat, raw);
            if (!parsed.ok) {
              status = "schema-invalid";
              error = `output failed validation: ${parsed.error}`;
            }
          }
        }
      }
    }

    return buildRun({
      seat,
      input,
      ws,
      parsed,
      audit,
      status,
      ...(error !== undefined ? { error } : {}),
      startedAt,
      finishedAt: new Date(),
      secrets: this.secrets,
    });
  }

  private spawnAndWait(
    args: string[],
    cwd: string,
    env: Record<string, string>,
    stdin: string,
    parser: StreamJsonParser,
    seat: Seat,
    signal: AbortSignal | undefined,
    on: {
      onStderr: (d: string) => void;
      onTimeout: () => void;
      onAbort: () => void;
      onSpawnError: (m: string) => void;
    },
  ): Promise<[number | null, NodeJS.Signals | null]> {
    return new Promise((resolveExit) => {
      let child: ChildProcess;
      try {
        child = spawn(this.binary, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (err: unknown) {
        on.onSpawnError(err instanceof Error ? err.message : String(err));
        resolveExit([null, null]);
        return;
      }
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // already gone
        }
      };
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), this.killGraceMs);
        killTimer.unref?.();
      };
      const deadline = setTimeout(
        () => {
          on.onTimeout();
          terminate();
        },
        Math.max(0, seat.budget.deadlineMs),
      );
      const onAbort = () => {
        on.onAbort();
        terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => parser.push(d));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => on.onStderr(d));
      child.stdin?.on("error", () => {
        /* the child may exit before reading stdin; the exit path reports why */
      });
      child.on("error", (err: Error) => {
        on.onSpawnError(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `claude CLI not found ("${this.binary}"); install Claude Code or set the binary path`
            : err.message,
        );
      });
      child.on("close", (code, sig) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        // Anything the seat left running in its process group (a backgrounded test command) dies with it.
        killGroup("SIGKILL");
        parser.end();
        resolveExit([code, sig]);
      });
      child.stdin?.end(stdin);
    });
  }
}
