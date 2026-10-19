import { isAbsolute, relative, resolve } from "node:path";
import type { TokenUsage, ToolUseAudit } from "@merge-safely/core";

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`. Builds the runner-observed audit
 * from assistant tool_use blocks matched to their tool_result: only calls whose result is not an error count,
 * and only reads that resolve inside the workspace land in filesRead. The model never writes the audit.
 * A `result` event is only kept if it is the last event on the stream (anything after it discards it).
 * Unknown line types are otherwise ignored.
 */

export interface CliResult {
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  totalCostUsd?: number;
  usage?: TokenUsage;
  resultText?: string;
  structuredOutput?: unknown;
  /** Present when the CLI reports them, e.g. "Reached maximum number of turns (1)". */
  errors?: string[];
  terminalReason?: string;
}

interface PendingCall {
  name: string;
  substantive: boolean;
  file?: string;
  command?: string;
  /** Set from the matching tool_result: true only when it arrived and was not an error. */
  succeeded: boolean;
}

const SUBSTANTIVE = new Set(["Read", "Grep", "Glob", "Bash"]);
/** The CLI's structured-output carrier; it is the submission, not investigation. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function usageFromCli(u: unknown): TokenUsage | undefined {
  const o = obj(u);
  if (!o) return undefined;
  return {
    in: num(o.input_tokens) ?? 0,
    out: num(o.output_tokens) ?? 0,
    cachedIn: num(o.cache_read_input_tokens) ?? 0,
    cacheWrite: num(o.cache_creation_input_tokens) ?? 0,
  };
}

export class StreamJsonParser {
  private buffer = "";
  private readonly calls = new Map<string, PendingCall>();
  private readonly perMessageUsage = new Map<string, TokenUsage>();
  private assistantTurns = 0;
  private readonly seenMessages = new Set<string>();
  result: CliResult | undefined;
  /** True when a result event was followed by more events and discarded. */
  resultSuperseded = false;
  /** Text of the last assistant text block, used when the result event is missing. */
  lastText: string | undefined;

  constructor(private readonly cwd: string) {}

  /** Feed a chunk of stdout. Complete lines are parsed; a partial tail is buffered. */
  push(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.line(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
  }

  line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return;
    let ev: Record<string, unknown> | undefined;
    try {
      ev = obj(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!ev || typeof ev.type !== "string") return;
    // A result only counts as the final word: any later event (e.g. a forged result written mid-run) voids it.
    if (ev.type !== "result" && this.result) {
      this.result = undefined;
      this.resultSuperseded = true;
    }
    if (ev.type === "assistant") this.onAssistant(ev);
    else if (ev.type === "user") this.onUser(ev);
    else if (ev.type === "result") this.onResult(ev);
  }

  private onAssistant(ev: Record<string, unknown>): void {
    // Sub-agent traffic (Task) is not this seat's own observation; the CLI is told to disallow it anyway.
    if (ev.parent_tool_use_id) return;
    const msg = obj(ev.message);
    if (!msg) return;
    const id = str(msg.id);
    if (id && !this.seenMessages.has(id)) {
      this.seenMessages.add(id);
      this.assistantTurns++;
    }
    const u = usageFromCli(msg.usage);
    if (id && u) {
      const prev = this.perMessageUsage.get(id);
      this.perMessageUsage.set(
        id,
        prev
          ? {
              in: Math.max(prev.in, u.in),
              out: Math.max(prev.out, u.out),
              cachedIn: Math.max(prev.cachedIn ?? 0, u.cachedIn ?? 0),
              cacheWrite: Math.max(prev.cacheWrite ?? 0, u.cacheWrite ?? 0),
            }
          : u,
      );
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      const block = obj(c);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) this.lastText = block.text;
      if (block.type !== "tool_use") continue;
      const toolId = str(block.id) ?? `anon-${this.calls.size}`;
      if (this.calls.has(toolId)) continue;
      const name = str(block.name) ?? "unknown";
      if (name === STRUCTURED_OUTPUT_TOOL) continue;
      const input = obj(block.input) ?? {};
      const call: PendingCall = { name, substantive: SUBSTANTIVE.has(name), succeeded: false };
      if (name === "Read") {
        const fp = str(input.file_path) ?? str(input.path);
        const rel = fp ? this.inside(fp) : undefined;
        if (rel) call.file = rel;
        // A read outside the checkout is not review work (and --restricted should have refused it).
        else call.substantive = false;
      }
      if (name === "Bash") {
        const cmd = str(input.command);
        if (cmd) call.command = cmd;
      }
      this.calls.set(toolId, call);
    }
  }

  private onUser(ev: Record<string, unknown>): void {
    if (ev.parent_tool_use_id) return;
    const msg = obj(ev.message);
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      const block = obj(c);
      if (block?.type !== "tool_result") continue;
      const call = this.calls.get(str(block.tool_use_id) ?? "");
      if (call) call.succeeded = block.is_error !== true;
    }
  }

  private onResult(ev: Record<string, unknown>): void {
    const r: CliResult = { isError: ev.is_error === true };
    const subtype = str(ev.subtype);
    if (subtype) r.subtype = subtype;
    const turns = num(ev.num_turns);
    if (turns !== undefined) r.numTurns = turns;
    const cost = num(ev.total_cost_usd);
    if (cost !== undefined) r.totalCostUsd = cost;
    const usage = usageFromCli(ev.usage);
    if (usage) r.usage = usage;
    const text = str(ev.result);
    if (text !== undefined) r.resultText = text;
    if ("structured_output" in ev && ev.structured_output !== null) r.structuredOutput = ev.structured_output;
    if (Array.isArray(ev.errors)) r.errors = ev.errors.filter((e): e is string => typeof e === "string");
    const tr = str(ev.terminal_reason);
    if (tr) r.terminalReason = tr;
    this.result = r;
  }

  /** Workspace-relative path, or undefined when the path resolves outside the workspace. */
  private inside(p: string): string | undefined {
    const r = relative(this.cwd, resolve(this.cwd, p));
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : undefined;
  }

  /** Usage summed from per-message events: the fallback when the process dies before its result event. */
  streamedUsage(): TokenUsage {
    let t: TokenUsage = { in: 0, out: 0, cachedIn: 0, cacheWrite: 0 };
    for (const u of this.perMessageUsage.values()) {
      t = {
        in: t.in + u.in,
        out: t.out + u.out,
        cachedIn: (t.cachedIn ?? 0) + (u.cachedIn ?? 0),
        cacheWrite: (t.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
      };
    }
    return t;
  }

  turns(): number {
    return this.result?.numTurns ?? this.assistantTurns;
  }

  audit(): Pick<ToolUseAudit, "substantiveCalls" | "totalCalls" | "filesRead" | "commandsRun"> {
    let substantiveCalls = 0;
    let totalCalls = 0;
    const files = new Set<string>();
    const commands: string[] = [];
    for (const c of this.calls.values()) {
      if (!c.succeeded) continue;
      totalCalls++;
      if (c.substantive) substantiveCalls++;
      if (c.file) files.add(c.file);
      if (c.command) commands.push(c.command);
    }
    return { substantiveCalls, totalCalls, filesRead: [...files], commandsRun: commands };
  }
}
