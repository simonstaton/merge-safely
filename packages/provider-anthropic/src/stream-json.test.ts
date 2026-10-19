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
    expect(p.audit()).toMatchObject({ commandsRun: ["git log"], filesRead: ["a.txt"], substantiveCalls: 2 });
  });

  it("ignores junk and unknown events, excludes denied calls and LS from substantive", () => {
    const p = new StreamJsonParser("/w");
    p.line("not json");
    p.line('{"type":"mystery"}');
    p.line(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "t1", name: "LS", input: { path: "/w" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "rm -rf /" } },
            { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/etc/passwd" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    );
    p.line(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        permission_denials: [{ tool_use_id: "t2" }],
      }),
    );
    expect(p.audit()).toEqual({ substantiveCalls: 1, totalCalls: 2, filesRead: ["/etc/passwd"], commandsRun: [] });
    expect(p.streamedUsage()).toMatchObject({ in: 10, out: 5 });
  });
});
