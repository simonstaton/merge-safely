import { createInterface } from "node:readline";
import type { CliIO } from "./io.js";

/** Interactive questions. Injected so tests can script answers. */
export interface Prompter {
  /** Ask for a line of text. Returns `defaultValue` (or "") for an empty answer. */
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Ask for a secret with echo off. Never echoes, never logs. */
  secret(question: string): Promise<string>;
}

interface RawStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** A prompter over the CLI's stdin/stderr (prompts go to stderr so stdout stays machine-readable). */
export function ttyPrompter(io: CliIO): Prompter {
  return {
    ask(question, defaultValue) {
      return new Promise((resolve) => {
        const rl = createInterface({ input: io.stdin, output: undefined, terminal: false });
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        io.stderr.write(`${question}${suffix}: `);
        let done = false;
        const finish = (answer: string) => {
          if (done) return;
          done = true;
          rl.close();
          const a = answer.trim();
          resolve(a === "" ? (defaultValue ?? "") : a);
        };
        rl.once("line", finish);
        rl.once("close", () => finish(""));
      });
    },
    secret(question) {
      return readHidden(io.stdin as RawStream, io.stderr, question);
    },
  };
}

/** Read one line from a TTY in raw mode without echoing it. Ctrl-C aborts the process like a normal prompt. */
export function readHidden(stdin: RawStream, out: { write(s: string): unknown }, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    out.write(`${question}: `);
    const canRaw = typeof stdin.setRawMode === "function" && stdin.isTTY === true;
    const wasRaw = stdin.isRaw === true;
    if (canRaw) stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (canRaw) stdin.setRawMode?.(wasRaw);
      stdin.pause();
      out.write("\n");
    };
    const onEnd = () => {
      cleanup();
      resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** A prompter that refuses: used when stdin is not a TTY. */
export function noPrompter(hint: string): Prompter {
  const fail = async (): Promise<string> => {
    throw new Error(hint);
  };
  return { ask: fail, secret: fail };
}
