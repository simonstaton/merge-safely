import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeScenario {
  /** Lines written to stdout, one per line. */
  lines?: string[];
  /** A fixture file to replay (absolute path). */
  fixture?: string;
  stderr?: string;
  exitCode?: number;
  /** Sleep this long before exiting (after output). */
  sleepMs?: number;
  /** Ignore SIGTERM so the runner must escalate to SIGKILL. */
  ignoreTerm?: boolean;
  /** Rewrite this string in replayed lines (e.g. a fixture's /workspace to a real temp dir). */
  replace?: { from: string; to: string };
  /** Print this for `--version`. */
  version?: string;
}

export interface FakeRecord {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
}

/** Write a node script that behaves like `claude -p` for one scenario. Returns its path and a record reader. */
export function fakeClaude(s: FakeScenario): { binary: string; record: () => FakeRecord; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const recordPath = join(dir, "record.json");
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(s));
  const script = `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, "utf8"));
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write((s.version || "2.1.303") + " (Claude Code)\\n"); process.exit(0); }
if (s.ignoreTerm) process.on("SIGTERM", () => {});
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd() }));
  const lines = s.fixture ? fs.readFileSync(s.fixture, "utf8").split("\\n") : (s.lines || []);
  for (let l of lines) {
    if (!l) continue;
    if (s.replace) l = l.split(s.replace.from).join(s.replace.to);
    process.stdout.write(l + "\\n");
  }
  if (s.stderr) process.stderr.write(s.stderr);
  const finish = () => process.exit(s.exitCode || 0);
  if (s.sleepMs) setTimeout(finish, s.sleepMs); else finish();
});
`;
  const binary = join(dir, "claude");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { binary, dir, record: () => JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord };
}
