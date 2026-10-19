/**
 * `merge-safely eval` command semantics, exported for the CLI package to wire:
 *
 *   merge-safely eval --suite <dir> [--dry] [--format text|markdown|json] [--ids a,b] [--kinds incident,clean]
 *                     [--concurrency n] [--policy <file>] [--compare <baseline.json>] [--out <file>]
 *   merge-safely eval init <dir> [--case <id> --kind incident|clean|regression --title "..."] [--name <suite name>]
 *
 * Exit codes: 0 every gate holds; 1 a gate failed (any case failed or was unresolved, recall below minRecall,
 * false-block rate above maxFalseBlock, or a --compare baseline case regressed); 2 usage, flag or validation error.
 * Arguments are parsed strictly: an unknown flag is a usage error, never silently ignored.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parsePolicy } from "@merge-safely/core";
import type { OctokitLike } from "@merge-safely/github";
import { parse as parseYaml } from "yaml";
import { evaluateBreakers } from "./breakers.js";
import type { GateFactory } from "./gate.js";
import { compareReports, type ReportComparison, type ReportFormat, renderComparison, renderReport } from "./report.js";
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
                    [--concurrency n] [--policy <file>] [--compare <baseline.json>] [--out <file>]
  merge-safely eval init <dir> [--case <id> --kind incident|clean|regression --title "..."] [--name <suite name>]
`;

class UsageError extends Error {}

type FlagKind = "boolean" | "value";
const RUN_FLAGS: Record<string, FlagKind> = {
  suite: "value",
  dry: "boolean",
  format: "value",
  ids: "value",
  kinds: "value",
  concurrency: "value",
  policy: "value",
  compare: "value",
  out: "value",
  help: "boolean",
};
const INIT_FLAGS: Record<string, FlagKind> = {
  case: "value",
  kind: "value",
  title: "value",
  name: "value",
  help: "boolean",
};

interface Parsed {
  positional: string[];
  values: Map<string, string>;
  booleans: Map<string, boolean>;
}

/** `--flag`, `--flag value` and `--flag=value`. Booleans take `--flag` or `--flag=<v>` (only "false"/"0"/"no" is false). */
export function parseArgs(argv: string[], spec: Record<string, FlagKind>): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Map<string, boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      if (a.startsWith("-") && a.length > 1) throw new UsageError(`unknown flag ${a}`);
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === "boolean") {
      const raw = eq > 0 ? a.slice(eq + 1).toLowerCase() : "true";
      booleans.set(name, !["false", "0", "no", "off"].includes(raw));
      continue;
    }
    if (values.has(name)) throw new UsageError(`--${name} given more than once`);
    if (eq > 0) {
      values.set(name, a.slice(eq + 1));
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    values.set(name, v);
    i++;
  }
  return { positional, values, booleans };
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

async function runInit(argv: string[], io: EvalCliIo): Promise<number> {
  const p = parseArgs(argv, INIT_FLAGS);
  if (p.booleans.get("help")) {
    io.stdout(EVAL_USAGE);
    return 0;
  }
  const dir = p.positional[0];
  if (!dir || p.positional.length > 1) throw new UsageError("eval init needs exactly one directory");
  const name = p.values.get("name");
  const id = p.values.get("case");
  const kind = p.values.get("kind") ?? "incident";
  if (!isKind(kind)) throw new UsageError(`--kind must be one of ${CASE_KINDS.join(", ")}`);
  if (!id && (p.values.has("kind") || p.values.has("title"))) throw new UsageError("--kind and --title need --case");
  const created = await initSuite(dir, name ? { name } : {});
  io.stdout(created ? `created suite ${dir}/suite.yml\n` : `suite ${dir} already exists\n`);
  if (id) {
    const r = await scaffoldCase(dir, { id, kind, title: p.values.get("title") ?? id });
    io.stdout(
      `created case ${r.dir}\n  edit case.yml and fill base/ and head/ (see README.md in the case); it fails validation until then\n`,
    );
  }
  return 0;
}

function isSuiteResult(v: unknown): v is SuiteResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { cases?: unknown; summary?: unknown; suite?: unknown };
  return (
    Array.isArray(o.cases) &&
    o.cases.every(
      (c: unknown) => typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string",
    ) &&
    typeof o.summary === "object" &&
    o.summary !== null &&
    typeof o.suite === "object" &&
    o.suite !== null
  );
}

async function readBaseline(path: string): Promise<SuiteResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err: unknown) {
    throw new UsageError(`--compare ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isSuiteResult(parsed))
    throw new UsageError(`--compare ${path} is not a JSON eval report (write one with --out)`);
  return parsed;
}

async function readPolicyOverride(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(path, "utf8"));
  } catch (err: unknown) {
    throw new UsageError(`--policy ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`--policy ${path} must be a YAML or JSON policy document`);
  }
  const check = parsePolicy(parsed);
  if (!check.ok) throw new UsageError(`--policy ${path} is not a valid policy:\n  ${check.errors.join("\n  ")}`);
  return parsed as Record<string, unknown>;
}

async function runEval(argv: string[], io: EvalCliIo): Promise<number> {
  const p = parseArgs(argv, RUN_FLAGS);
  if (p.booleans.get("help")) {
    io.stdout(EVAL_USAGE);
    return 0;
  }
  if (p.positional.length > 1 || (p.positional.length === 1 && p.values.has("suite"))) {
    throw new UsageError(`unexpected argument ${p.positional.at(-1)}`);
  }
  const suite = p.values.get("suite") ?? p.positional[0];
  if (!suite) throw new UsageError("--suite <dir> is required");
  const format = p.values.get("format") ?? "text";
  if (!isFormat(format)) throw new UsageError("--format must be text, markdown or json");
  const kinds = list(p.values.get("kinds"));
  for (const k of kinds ?? []) if (!isKind(k)) throw new UsageError(`unknown kind "${k}"`);
  const concurrencyRaw = p.values.get("concurrency");
  const concurrency = concurrencyRaw === undefined ? 1 : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError("--concurrency must be a positive integer");
  const dry = p.booleans.get("dry") === true;
  if (!dry && !io.gateFactory) {
    throw new UsageError("full eval runs need configured model connections; use --dry for tier/triage checks only");
  }
  // Validate inputs before a (possibly paid) run starts.
  const comparePath = p.values.get("compare");
  const baseline = comparePath ? await readBaseline(comparePath) : undefined;
  const policyPath = p.values.get("policy");
  const policyOverride = policyPath ? await readPolicyOverride(policyPath) : undefined;
  const ids = list(p.values.get("ids"));

  const result = await runSuite(suite, {
    ...(io.gateFactory ? { gateFactory: io.gateFactory } : {}),
    ...(io.github ? { github: io.github } : {}),
    ...(policyOverride ? { policyOverride } : {}),
    dry,
    concurrency,
    filter: { ...(ids ? { ids } : {}), ...(kinds ? { kinds: kinds.filter(isKind) } : {}) },
  });
  const comparison: ReportComparison | undefined = baseline ? compareReports(baseline, result) : undefined;
  const breakers = evaluateBreakers(result);

  if (format === "json") {
    io.stdout(`${JSON.stringify({ ...result, breakers, ...(comparison ? { comparison } : {}) }, null, 2)}\n`);
  } else {
    io.stdout(renderReport(result, format));
    if (
      breakers.widenTriage ||
      breakers.raiseQuorumTier !== undefined ||
      breakers.narrowTriage ||
      breakers.fixTiering
    ) {
      io.stdout(
        `\nCircuit breakers (suggestions only, no policy was changed):\n${breakers.reasons.map((r) => `  - ${r}`).join("\n")}\n`,
      );
    }
    if (comparison) io.stdout(`\n${renderComparison(comparison, format === "markdown" ? "markdown" : "text")}`);
  }
  const out = p.values.get("out");
  if (out) await writeFile(out, renderReport(result, "json"));
  if (!result.summary.ok) return 1;
  return comparison && comparison.regressed.length > 0 ? 1 : 0;
}

/** Run `merge-safely eval ...` with argv after "eval". Returns the process exit code; never calls process.exit. */
export async function evalCommand(argv: string[], io: EvalCliIo): Promise<number> {
  try {
    if (argv[0] === "init") return await runInit(argv.slice(1), io);
    return await runEval(argv, io);
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
