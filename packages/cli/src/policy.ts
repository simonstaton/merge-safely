import { readFile } from "node:fs/promises";
import { DEFAULT_POLICY, LENS_IDS, type Policy, parsePolicy, policyHash } from "@merge-safely/core";
import { getLens } from "@merge-safely/lenses";
import { parse as parseYaml } from "yaml";
import { CliError } from "./errors.js";

export const POLICY_FILE = ".merge-safely.yml";

export interface LoadedPolicy {
  policy: Policy;
  hash: string;
  /** Where it came from: a path, `owner/name@ref:.merge-safely.yml`, or "defaults". */
  source: string;
}

export function defaultLoadedPolicy(): LoadedPolicy {
  return { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" };
}

/** Decode YAML text. Errors carry the line/column, not the source text. */
export function decodeYaml(text: string, source: string): unknown {
  try {
    return parseYaml(text);
  } catch (err: unknown) {
    const pos =
      typeof err === "object" && err !== null && "linePos" in err && Array.isArray(err.linePos) && err.linePos[0]
        ? ` at line ${String((err.linePos[0] as { line?: number }).line ?? "?")}`
        : "";
    throw new CliError("POLICY_INVALID", `${source} is not valid YAML${pos}`);
  }
}

/** Parse policy text (YAML or JSON) or throw a POLICY_INVALID error listing every problem. */
export function policyFromText(text: string, source: string): LoadedPolicy {
  const r = parsePolicy(decodeYaml(text, source) ?? {});
  if (!r.ok) throw new CliError("POLICY_INVALID", `${source} is invalid: ${r.errors.join("; ")}`);
  return { policy: r.policy, hash: r.hash, source };
}

export async function readPolicyFile(path: string): Promise<LoadedPolicy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (_err: unknown) {
    throw new CliError("POLICY_NOT_FOUND", `policy file not found: ${path}`);
  }
  return policyFromText(text, path);
}

/** `path` when it exists, else the defaults. */
export async function readPolicyOrDefault(path: string): Promise<LoadedPolicy> {
  try {
    await readFile(path, "utf8");
  } catch (_err: unknown) {
    return defaultLoadedPolicy();
  }
  return readPolicyFile(path);
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}

/** Schema errors, plus warnings for connections the policy names that do not exist and lenses nobody ships. */
export function lintPolicy(text: string, source: string, connectionIds: string[] | undefined): LintResult {
  let decoded: unknown;
  try {
    decoded = decodeYaml(text, source);
  } catch (err: unknown) {
    return { errors: [err instanceof Error ? err.message : String(err)], warnings: [] };
  }
  const r = parsePolicy(decoded ?? {});
  if (!r.ok) return { errors: r.errors, warnings: [] };
  const warnings: string[] = [];
  const p = r.policy;
  if (connectionIds) {
    const known = new Set(connectionIds);
    const refs: Array<[string, string | undefined]> = [
      ["models.hunters", p.models.hunters?.connection],
      ["models.judges", p.models.judges?.connection],
      ["models.fallback", p.models.fallback?.connection],
      ...Object.entries(p.models.perLens).map(([lens, sel]): [string, string] => [
        `models.perLens.${lens}`,
        sel.connection,
      ]),
    ];
    for (const [where, id] of refs) {
      if (id !== undefined && !known.has(id)) {
        warnings.push(
          `${where}: connection "${id}" does not exist (known: ${connectionIds.length ? connectionIds.join(", ") : "none"}); add it with \`merge-safely connect\``,
        );
      }
    }
  }
  const builtin = new Set<string>(LENS_IDS);
  for (const t of ["t1", "t2", "t3"] as const) {
    for (const lens of p.panel[t].hunters) {
      if (!builtin.has(lens) && !getLens(lens)) warnings.push(`panel.${t}.hunters: unknown lens "${lens}"`);
    }
  }
  const { t1, t2, t3 } = p.tiers.thresholds;
  if (!(t1 <= t2 && t2 <= t3)) warnings.push("tiers.thresholds: expected t1 <= t2 <= t3");
  return { errors: [], warnings };
}

/** Written by `policy init`. Every value shown is the default; it must parse to exactly DEFAULT_POLICY plus models. */
export const POLICY_TEMPLATE = `# Merge Safely policy. Every key is optional; what is shown here is the default.
# Reference: docs/policy.md. Check it with: merge-safely policy lint
version: 1

tiers:
  # Composite risk score (0-100) thresholds for tiers 1, 2 and 3.
  thresholds: { t1: 20, t2: 50, t3: 80 }
  # Paths that make a change tier 3 whatever its size. Uncomment to replace the built-in list.
  # criticalPaths:
  #   - "**/migrations/**"
  #   - "**/auth/**"
  #   - ".github/workflows/**"
  flagRemovalIsCritical: true      # deleting a feature-flag read is tier 3

triage:
  # Tiny changes are auto-passed without a model call.
  maxLines: 30
  maxFiles: 3
  docsOnlyAutoPass: true

panel:
  t1: { hunters: [correctness, repro], judges: 1 }
  t2: { hunters: [intent, correctness, repro, design-fidelity], judges: 2 }
  t3: { hunters: [intent, correctness, repro, security, perf, rollout, blast-radius], judges: 2, secondJudgeRound: true }

# Which connections (made with \`merge-safely connect\`) serve each role. Without this block the gate picks
# automatically from every connection: hunters a mid-tier model, judges the strongest model available.
# models:
#   hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
#   judges:   { connection: anthropic-main, model: claude-opus-5-5 }
#   fallback: { connection: openai-main, model: gpt-5 }
#   decorrelate: true

quorum:
  t1: 1
  t2: 2
  t3: 2

proofOfWork:
  minSubstantiveCalls: 3
  requireFilesRead: true

rounds:
  max: 3

reporting:
  checkName: "merge-safely/verdict"
  postPrReview: true
  showCostInSummary: true

budget:
  perSeatUsd: 5          # one reviewer run
  perChangeUsd: 25       # one PR across all rounds
  onOverBudget: downgrade-then-block

runner:
  # Commands reviewers may run in the checkout, e.g. ["npm test"]. Default: none.
  allowedCommands: []
`;
