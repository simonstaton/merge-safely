import { isAbsolute, relative } from "node:path";
import type { TokenUsage, ToolUseAudit } from "@merge-safely/core";

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`. Builds the runner-observed audit
 * from assistant tool_use blocks; the model never writes it. Unknown line types are ignored.
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
  private readonly denied = new Set<string>();
  private readonly perMessageUsage = new Map<string, TokenUsage>();
  private assistantTurns = 0;
  private readonly seenMessages = new Set<string>();
  result: CliResult | undefined;
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
    if (!ev) return;
    if (ev.type === "assistant") this.onAssistant(ev);
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
      const call: PendingCall = { name, substantive: SUBSTANTIVE.has(name) };
      if (name === "Read") {
        const fp = str(input.file_path) ?? str(input.path);
        if (fp) call.file = this.rel(fp);
      }
      if (name === "Bash") {
        const cmd = str(input.command);
        if (cmd) call.command = cmd;
      }
      this.calls.set(toolId, call);
    }
  }

  private onResult(ev: Record<string, unknown>): void {
    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    for (const d of denials) {
      const id = str(obj(d)?.tool_use_id);
      if (id) this.denied.add(id);
    }
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

  private rel(p: string): string {
    if (!isAbsolute(p)) return p;
    const r = relative(this.cwd, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
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
    for (const [id, c] of this.calls) {
      if (this.denied.has(id)) continue;
      totalCalls++;
      if (c.substantive) substantiveCalls++;
      if (c.file) files.add(c.file);
      if (c.command) commands.push(c.command);
    }
    return { substantiveCalls, totalCalls, filesRead: [...files], commandsRun: commands };
  }
}
