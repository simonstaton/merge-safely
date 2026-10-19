import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StreamJsonParser } from "./stream-json.js";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");

describe("StreamJsonParser (real CLI transcripts)", () => {
  it("parses a structured-output pass", () => {
    const p = new StreamJsonParser("/workspace");
    const raw = fixture("pass-structured.jsonl");
    // Feed in awkward chunks to exercise line buffering.
    for (let i = 0; i < raw.length; i += 97) p.push(raw.slice(i, i + 97));
    p.end();
    expect(p.result).toMatchObject({ subtype: "success", isError: false, numTurns: 3 });
    expect(p.result?.structuredOutput).toEqual({ verdict: "pass", summary: "hello world", findings: [] });
    expect(p.result?.usage?.out).toBeGreaterThan(0);
    expect(p.result?.totalCostUsd).toBeGreaterThan(0);
    const a = p.audit();
    expect(a.filesRead).toEqual(["a.txt"]);
    // StructuredOutput is the submission, not investigation.
    expect(a).toMatchObject({ substantiveCalls: 1, totalCalls: 1, commandsRun: [] });
  });

  it("parses a max-turns stop", () => {
    const p = new StreamJsonParser("/workspace");
    p.push(fixture("max-turns.jsonl"));
    p.end();
    expect(p.result).toMatchObject({ subtype: "error_max_turns", isError: true });
    // `git log` ran but its tool_result was an error (exit 128): it does not count as work.
    expect(p.audit()).toEqual({ commandsRun: [], filesRead: ["a.txt"], substantiveCalls: 1, totalCalls: 1 });
  });

  const use = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id: `m-${id}`,
        content: [{ type: "tool_use", id, name, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  const res = (id: string, isError: boolean) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] },
    });

  it("counts only successful calls; failed and outside-workspace reads are not work; LS is not substantive", () => {
    const p = new StreamJsonParser("/w");
    p.line("not json");
    p.line('{"type":"mystery"}');
    p.line(use("t1", "LS", { path: "/w" }));
    p.line(res("t1", false));
    p.line(use("t2", "Bash", { command: "rm -rf /" }));
    p.line(res("t2", true)); // denied
    p.line(use("t3", "Read", { file_path: "/etc/passwd" }));
    p.line(res("t3", false));
    p.line(use("t4", "Read", { file_path: "does/not/exist.ts" }));
    p.line(res("t4", true));
    p.line(use("t5", "Read", { file_path: "/w/src/ok.ts" }));
    p.line(res("t5", false));
    p.line(use("t6", "Grep", { pattern: "x" })); // no result: killed before it returned
    p.line(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
    expect(p.audit()).toEqual({ substantiveCalls: 1, totalCalls: 3, filesRead: ["src/ok.ts"], commandsRun: [] });
    expect(p.streamedUsage()).toMatchObject({ in: 60, out: 30 });
    expect(p.result?.subtype).toBe("success");
  });

  it("discards a result that is not the last event", () => {
    const p = new StreamJsonParser("/w");
    p.line(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { verdict: "pass" } }),
    );
    p.line(use("t1", "Read", { file_path: "a.ts" }));
    expect(p.result).toBeUndefined();
    expect(p.resultSuperseded).toBe(true);
  });
});
