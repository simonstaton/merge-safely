import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readHidden, ttyPrompter } from "../src/prompt.js";

describe("prompts", () => {
  it("reads a hidden line without echoing it, handling backspace", async () => {
    const stdin = new PassThrough();
    let out = "";
    const p = readHidden(stdin, { write: (s: string) => (out += s) }, "Key");
    stdin.write("sk-secx");
    stdin.write("\u007fret\r");
    expect(await p).toBe("sk-secret");
    expect(out).toBe("Key: \n");
  });

  it("asks with a default", async () => {
    const stdin = new PassThrough();
    let err = "";
    const pr = ttyPrompter({
      stdin,
      stdout: { write: () => true },
      stderr: { write: (s: string) => (err += s) },
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    const a = pr.ask("Base URL", "http://x");
    stdin.write("\n");
    expect(await a).toBe("http://x");
    expect(err).toContain("Base URL [http://x]: ");
  });
});
