import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  type Connection,
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
import { classifyExit } from "./classify.js";
import { priceUsage } from "./models.js";
import { buildRun, outputSchemaFor, type ParsedOutput, parseForSeat } from "./output.js";
import { scrub, secretValues } from "./secrets.js";
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
}

/** Read-only built-ins the reviewer may use. Write tools, web and sub-agents are denied outright. */
export const CLI_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export const CLI_READ_TOOLS = ["Read", "Grep", "Glob", "LS"] as const;
export const CLI_GIT_COMMANDS = ["git diff", "git log", "git blame", "git show"] as const;
export const CLI_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
] as const;

/** Variables a CLI needs to run at all. Everything else, credentials included, is dropped. */
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
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
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/** Privacy flags verified in the Claude Code binary: no telemetry, error reporting, auto-update or other phone-home. */
const PRIVACY_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
};

const SAFE_COMMAND = /^[A-Za-z0-9 ._/=:@+-]+$/;

/** Allowed-tools list: read tools, git read commands, plus one Bash(<cmd>:*) per policy-allowed command. */
export function cliAllowedTools(allowedCommands: readonly string[], onRejected?: (cmd: string) => void): string[] {
  const out: string[] = [...CLI_READ_TOOLS, ...CLI_GIT_COMMANDS.map((c) => `Bash(${c}:*)`)];
  for (const raw of allowedCommands) {
    const cmd = raw.trim();
    // Parentheses, commas, globs or shell metacharacters would widen or break the permission rule.
    if (!cmd || !SAFE_COMMAND.test(cmd)) {
      onRejected?.(raw);
      continue;
    }
    const rule = `Bash(${cmd}:*)`;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/** Child environment: a scrubbed allowlist plus exactly the credential the connection kind dictates. */
export function buildCliEnv(conn: Connection, cfg: ClaudeCodeRunnerConfig = {}): Record<string, string> {
  const src = cfg.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV_ALLOWLIST, ...(cfg.envPassthrough ?? [])]) {
    if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) continue; // credentials only ever come from the connection
    const v = src[k];
    if (typeof v === "string") env[k] = v;
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

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1]?.slice(0, 500);
}

const SCHEMA_INSTRUCTION = (role: Seat["role"]) =>
  [
    "",
    "## Output",
    "You are a read-only reviewer: never modify files. Investigate with Read, Grep, Glob and the allowed git commands.",
    `When finished, return your final ${role === "judge" ? "votes" : "review"} as structured output matching the provided JSON schema.`,
    "If structured output is unavailable, reply with only a single JSON object matching the schema, with no prose.",
  ].join("\n");

/**
 * Claude Code CLI runner: `claude -p` in print mode with stream-json output, read-only allowlisted tools and
 * the seat's JSON schema. The audit is built from the CLI's own tool_use events. Usage arrives with the
 * final result event (the CLI does not stream per-turn cost), so onUsage fires once per run.
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
    this.secrets = secretValues(conn);
    const fromConn = typeof conn.options?.claudeBinary === "string" ? conn.options.claudeBinary : undefined;
    this.binary = cfg.binary ?? fromConn ?? "claude";
    this.killGraceMs = cfg.killGraceMs ?? 5000;
  }

  private get planIncluded(): boolean {
    return this.model.zeroCost === true || this.conn.kind === "subscription";
  }

  buildArgs(seat: Seat, input: ReviewerInput): string[] {
    const allowed = cliAllowedTools(input.allowedCommands, (cmd) =>
      this.opts.logger?.warn("anthropic-cli: allowed command rejected (unsafe characters)", { command: cmd }),
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
      "--tools",
      CLI_TOOLS.join(","),
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      CLI_DISALLOWED_TOOLS.join(","),
      "--permission-mode",
      "dontAsk",
      // Never load settings (hooks!) or MCP servers from the checkout under review or the host.
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--json-schema",
      JSON.stringify(outputSchemaFor(seat, input)),
      "--append-system-prompt",
      `${input.prompt.system}\n${SCHEMA_INSTRUCTION(seat.role)}`,
    ];
    if (seat.model.effort) args.push("--effort", seat.model.effort);
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

    if (seat.budget.maxUsd !== undefined && !this.planIncluded && !this.model.pricing) {
      this.opts.logger?.warn("anthropic-cli: model has no local pricing; relying on the CLI's --max-budget-usd", {
        model: this.model.name,
        seat: seat.id,
      });
    }

    if (signal?.aborted) aborted = true;
    else if (!existsSync(ws.cwd)) spawnError = `workspace directory does not exist: ${ws.cwd}`;
    else {
      try {
        exitCode = await new Promise<number | null>((resolve) => {
          let child: ChildProcess;
          try {
            child = spawn(this.binary, this.buildArgs(seat, input), {
              cwd: ws.cwd,
              env: buildCliEnv(this.conn, this.cfg),
              stdio: ["pipe", "pipe", "pipe"],
              detached: process.platform !== "win32",
            });
          } catch (err: unknown) {
            spawnError = err instanceof Error ? err.message : String(err);
            resolve(null);
            return;
          }
          let killTimer: NodeJS.Timeout | undefined;
          const kill = (sig: NodeJS.Signals) => {
            try {
              if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
              else child.kill(sig);
            } catch {
              child.kill(sig);
            }
          };
          const terminate = () => {
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), this.killGraceMs);
            killTimer.unref?.();
          };
          const deadline = setTimeout(
            () => {
              timedOut = true;
              terminate();
            },
            Math.max(0, seat.budget.deadlineMs),
          );
          const onAbort = () => {
            aborted = true;
            terminate();
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (d: string) => parser.push(d));
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (d: string) => {
            stderr = (stderr + d).slice(-8192);
          });
          child.stdin?.on("error", () => {
            /* the child may exit before reading stdin; the exit path reports why */
          });
          child.on("error", (err: Error) => {
            spawnError =
              (err as NodeJS.ErrnoException).code === "ENOENT"
                ? `claude CLI not found ("${this.binary}"); install Claude Code or set the binary path`
                : err.message;
          });
          child.on("close", (code) => {
            clearTimeout(deadline);
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", onAbort);
            parser.end();
            resolve(code);
          });
          child.stdin?.end(input.prompt.user);
        });
      } catch (err: unknown) {
        spawnError = err instanceof Error ? err.message : String(err);
      }
    }

    const result = parser.result;
    // Usage: the result event's totals; if the process died first, the per-message usage it streamed.
    const tokens: TokenUsage = result?.usage ?? parser.streamedUsage();
    let usd: number | undefined;
    if (this.planIncluded) usd = 0;
    else usd = result?.totalCostUsd ?? priceUsage(this.model.pricing, tokens);
    if (tokens.in || tokens.out || tokens.cachedIn || tokens.cacheWrite) {
      this.opts.onUsage?.({ tokens, ...(usd !== undefined ? { usd } : {}) });
    }

    const audit: ToolUseAudit = { ...parser.audit(), tokens, wallMs: Date.now() - t0, turns: parser.turns() };
    if (usd !== undefined) audit.costUsd = usd;

    let status: RunStatus;
    let error: string | undefined;
    let parsed: ParsedOutput | undefined;
    if (spawnError && !result) {
      status = "error";
      error = spawnError;
    } else if (result?.subtype && /structured_output/.test(result.subtype)) {
      status = "schema-invalid";
      error = `claude CLI could not produce schema-valid output (${result.subtype})`;
    } else {
      const c = classifyExit({
        timedOut,
        aborted,
        deadlineMs: seat.budget.deadlineMs,
        maxTurns: seat.budget.maxTurns,
        ...(seat.budget.maxUsd !== undefined ? { maxUsd: seat.budget.maxUsd } : {}),
        ...(usd !== undefined && !this.planIncluded ? { usd } : {}),
        exitCode: result || exitCode !== null ? exitCode : 1,
        ...(result?.subtype ? { subtype: result.subtype } : {}),
        isError: result?.isError ?? false,
        detail: lastLine(stderr) ?? result?.errors?.[0] ?? (result ? undefined : "no result event from claude CLI"),
      });
      status = c.status;
      error = c.error;
      if (status === "ok") {
        const raw = result?.structuredOutput ?? extractJson(result?.resultText ?? parser.lastText ?? "");
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

    return buildRun({
      seat,
      input,
      ws,
      parsed,
      audit,
      status,
      ...(error !== undefined ? { error: scrub(error, this.secrets) } : {}),
      startedAt,
      finishedAt: new Date(),
    });
  }
}
