/**
 * `merge-safely eval` command semantics, exported for the CLI package to wire:
 *
 *   merge-safely eval --suite <dir> [--dry] [--format text|markdown|json] [--ids a,b] [--kinds incident,clean]
 *                     [--concurrency n] [--compare <baseline.json>] [--out <file>]
 *   merge-safely eval init <dir> [--case <id> --kind incident|clean|regression --title "..."] [--name <suite name>]
 *
 * Exit codes: 0 every gate holds; 1 a gate failed (recall below minRecall, false-block rate above maxFalseBlock, a
 * regression case failed, a case errored, or in --dry any case failed); 2 usage or suite validation error.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { OctokitLike } from "@merge-safely/github";
import { evaluateBreakers } from "./breakers.js";
import type { GateFactory } from "./gate.js";
import { compareReports, exitCodeFor, type ReportFormat, renderComparison, renderReport } from "./report.js";
import { runSuite } from "./runner.js";
import { CASE_KINDS, type CaseKind, SuiteValidationError } from "./suite.js";
import { initSuite, scaffoldCase } from "./template.js";
import type { SuiteResult } from "./types.js";

export interface EvalCliIo {
  /** Builds the real gate per case; dry runs do not need it. */
  gateFactory?: GateFactory;
  github?: { octokit: OctokitLike };
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EVAL_USAGE = `usage:
  merge-safely eval --suite <dir> [--dry] [--format text|markdown|json] [--ids a,b] [--kinds incident,clean,regression]
                    [--concurrency n] [--compare <baseline.json>] [--out <file>]
  merge-safely eval init <dir> [--case <id> --kind incident|clean|regression --title "..."] [--name <suite name>]
`;

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["dry", "help"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      flags.set(name, v);
      i++;
    }
  }
  return { positional, flags };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

const list = (v: string | undefined): string[] | undefined =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function isFormat(v: string): v is ReportFormat {
  return v === "text" || v === "markdown" || v === "json";
}

function isKind(v: string): v is CaseKind {
  return (CASE_KINDS as readonly string[]).includes(v);
}

async function runInit(p: Parsed, io: EvalCliIo): Promise<number> {
  const dir = p.positional[1];
  if (!dir) throw new UsageError("eval init needs a directory");
  const name = str(p, "name");
  const created = await initSuite(dir, name ? { name } : {});
  io.stdout(created ? `created suite ${dir}/suite.yml\n` : `suite ${dir} already exists\n`);
  const id = str(p, "case");
  if (id) {
    const kind = str(p, "kind") ?? "incident";
    if (!isKind(kind)) throw new UsageError(`--kind must be one of ${CASE_KINDS.join(", ")}`);
    const r = await scaffoldCase(dir, { id, kind, title: str(p, "title") ?? id });
    io.stdout(`created case ${r.dir}\n  edit case.yml, then fill base/ and head/ (see README.md in the case)\n`);
  }
  return 0;
}

function isSuiteResult(v: unknown): v is SuiteResult {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { cases?: unknown }).cases) &&
    typeof (v as { summary?: unknown }).summary === "object"
  );
}

async function runEval(p: Parsed, io: EvalCliIo): Promise<number> {
  const suite = str(p, "suite") ?? p.positional[0];
  if (!suite) throw new UsageError("--suite <dir> is required");
  const format = str(p, "format") ?? "text";
  if (!isFormat(format)) throw new UsageError("--format must be text, markdown or json");
  const kinds = list(str(p, "kinds"));
  for (const k of kinds ?? []) if (!isKind(k)) throw new UsageError(`unknown kind "${k}"`);
  const concurrencyRaw = str(p, "concurrency");
  const concurrency = concurrencyRaw === undefined ? 1 : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError("--concurrency must be a positive integer");
  const dry = p.flags.get("dry") === true;
  if (!dry && !io.gateFactory) {
    throw new UsageError("full eval runs need configured model connections; use --dry for tier/triage checks only");
  }
  const ids = list(str(p, "ids"));
  const result = await runSuite(suite, {
    ...(io.gateFactory ? { gateFactory: io.gateFactory } : {}),
    ...(io.github ? { github: io.github } : {}),
    dry,
    concurrency,
    filter: { ...(ids ? { ids } : {}), ...(kinds ? { kinds: kinds.filter(isKind) } : {}) },
  });
  const rendered = renderReport(result, format);
  io.stdout(rendered);
  const out = str(p, "out");
  if (out) await writeFile(out, renderReport(result, "json"));
  if (format !== "json") {
    const breakers = evaluateBreakers(result);
    if (breakers.widenTriage || breakers.raiseQuorumTier !== undefined || breakers.narrowTriage) {
      io.stdout(
        `\nCircuit breakers (suggestions only, no policy was changed):\n${breakers.reasons.map((r) => `  - ${r}`).join("\n")}\n`,
      );
    }
    const baseline = str(p, "compare");
    if (baseline) {
      const prev: unknown = JSON.parse(await readFile(baseline, "utf8"));
      if (!isSuiteResult(prev)) throw new UsageError(`${baseline} is not a JSON eval report (write one with --out)`);
      io.stdout(`\n${renderComparison(compareReports(prev, result), format === "markdown" ? "markdown" : "text")}`);
    }
  }
  return exitCodeFor(result);
}

/** Run `merge-safely eval ...` with argv after "eval". Returns the process exit code; never calls process.exit. */
export async function evalCommand(argv: string[], io: EvalCliIo): Promise<number> {
  try {
    const p = parseArgs(argv);
    if (p.flags.get("help") === true) {
      io.stdout(EVAL_USAGE);
      return 0;
    }
    if (p.positional[0] === "init") return await runInit(p, io);
    return await runEval(p, io);
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n${EVAL_USAGE}`);
      return 2;
    }
    if (err instanceof SuiteValidationError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
