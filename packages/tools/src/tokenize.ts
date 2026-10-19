/** Characters that would mean something to a shell. Rejected anywhere in the command, even inside quotes. */
const FORBIDDEN = /[;|&$`<>\n\r\0]/;

export type TokenizeResult = { ok: true; argv: string[] } | { ok: false; error: string };

/**
 * A tiny shell-less splitter: whitespace separates words, single and double quotes group them.
 * No expansion, no escapes, no operators. Anything shell-like is rejected rather than interpreted.
 */
export function tokenizeCommand(command: string): TokenizeResult {
  const bad = FORBIDDEN.exec(command);
  if (bad) {
    const ch = bad[0] === "\n" || bad[0] === "\r" ? "newline" : bad[0] === "\0" ? "NUL" : `'${bad[0]}'`;
    return { ok: false, error: `shell metacharacter ${ch} is not allowed (commands run without a shell)` };
  }
  const argv: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) {
        argv.push(cur);
        cur = "";
        inWord = false;
      }
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return { ok: false, error: "unterminated quote" };
  if (inWord) argv.push(cur);
  if (argv.length === 0) return { ok: false, error: "empty command" };
  return { ok: true, argv };
}

/** The command must equal an allowlisted entry or start with it followed by a space. */
export function matchAllowlist(command: string, allowed: readonly string[]): string | undefined {
  const cmd = command.trim();
  for (const raw of allowed) {
    const entry = raw.trim();
    if (!entry) continue;
    if (cmd === entry || cmd.startsWith(`${entry} `)) return entry;
  }
  return undefined;
}
