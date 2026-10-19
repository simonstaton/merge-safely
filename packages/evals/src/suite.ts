/**
 * Eval suite format (design section 10).
 *
 *   <suite>/suite.yml            { version: 1, name, description?, defaults?, gates? }
 *   <suite>/<case>/case.yml      one case per subdirectory
 *   <suite>/<case>/base/ head/   fixture trees (source.type "fixture")
 *   <suite>/<case>/change.diff   a recorded diff (source.type "diff")
 *
 * Directories without a case.yml are ignored, so a suite can hold shared notes or helper material.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PolicyInput } from "@merge-safely/core";
import { lensIds, listLenses } from "@merge-safely/lenses";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { confinedPath, FixtureError } from "./diff.js";

export const CASE_KINDS = ["incident", "clean", "regression"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** A policy fragment. Validated as a whole by the core policy schema once merged, so it is opaque here. */
const policyFragment = z.record(z.string(), z.unknown());

const tierLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "must be a relative path inside the case");

export const gatesSchema = z
  .object({
    /** Minimum share of incident cases that must block. */
    minRecall: z.number().min(0).max(1).default(0.8),
    /** Maximum share of clean cases allowed to block. */
    maxFalseBlock: z.number().min(0).max(1).default(0.1),
  })
  .strict();
export type SuiteGates = z.infer<typeof gatesSchema>;

export const suiteSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    description: z.string().optional(),
    defaults: z
      .object({
        /** Policy overrides applied to every case, on top of the core defaults. */
        policy: policyFragment.optional(),
        /** Shorthand for `policy.models`: which connections and models seat the panel. */
        models: policyFragment.optional(),
      })
      .strict()
      .optional(),
    gates: gatesSchema.default({}),
    /** Finding classes beyond the built-in lens registry (for third-party lenses). */
    extraFindingClasses: z.array(z.string().min(1)).default([]),
    /** Lens ids beyond the built-in lens registry. */
    extraLenses: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SuiteManifest = z.infer<typeof suiteSchema>;

const changedFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().optional(),
    status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]).default("modified"),
    additions: z.number().int().min(0).default(0),
    deletions: z.number().int().min(0).default(0),
  })
  .strict();

export const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixture"), base: relPath.default("base/"), head: relPath.default("head/") }).strict(),
  z.object({ type: z.literal("diff"), diff: relPath, files: z.array(changedFileSchema).optional() }).strict(),
  z
    .object({
      type: z.literal("github"),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name"),
      pr: z.number().int().positive(),
      /** Full commit SHA (40 or 64 hex) the incident merged at; the verdict is pinned to it. */
      headSha: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "must be a full commit SHA (40 or 64 hex characters)")
        .optional(),
      /**
       * Include PR comments (only those created before the head commit). Off by default: post-incident discussion
       * ("this caused the outage") hands the reviewer the answer.
       */
      includeComments: z.boolean().default(false),
    })
    .strict(),
]);
export type CaseSource = z.infer<typeof sourceSchema>;

export const expectedSchema = z
  .object({
    decision: z.enum(["pass", "block"]),
    tier: tierLevel.optional(),
    /** Deterministic triage outcome; checked in dry mode as well as full runs. */
    triage: z.enum(["auto-pass", "review"]).optional(),
    /** Lenses that must be seated for this change (checked against the estimate). */
    lenses: z.array(z.string().min(1)).optional(),
    /** At least one of these classes must be raised (blocks only). */
    findingClasses: z.array(z.string().min(1)).min(1).optional(),
    /** A matching finding must point at one of these files (blocks only). */
    files: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type CaseExpected = z.infer<typeof expectedSchema>;

export const caseSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, dot, dash or underscore")
      .max(80),
    title: z.string().min(1),
    kind: z.enum(CASE_KINDS),
    expected: expectedSchema,
    source: sourceSchema,
    change: z
      .object({
        title: z.string().min(1),
        body: z.string().default(""),
        author: z.string().min(1).optional(),
        authorKind: z.enum(["human", "bot", "agent"]).optional(),
        labels: z.array(z.string()).optional(),
        baseRef: z.string().optional(),
        headRef: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Per-case policy overrides, applied after the suite defaults. */
    policy: policyFragment.optional(),
    /** What the incident was and how it was (or should have been) caught. */
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.kind === "incident" && c.expected.decision !== "block") {
      ctx.addIssue({ code: "custom", path: ["expected", "decision"], message: "incident cases must expect block" });
    }
    if (c.kind === "clean" && c.expected.decision !== "pass") {
      ctx.addIssue({ code: "custom", path: ["expected", "decision"], message: "clean cases must expect pass" });
    }
    if (c.expected.decision === "pass" && (c.expected.findingClasses || c.expected.files)) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "findingClasses and files only apply to cases expected to block",
      });
    }
    if (c.expected.decision === "block" && c.expected.triage === "auto-pass") {
      ctx.addIssue({
        code: "custom",
        path: ["expected", "triage"],
        message: "a case expected to block cannot expect triage auto-pass",
      });
    }
  });
export type CaseSpec = z.infer<typeof caseSchema>;

export interface LoadedCase {
  spec: CaseSpec;
  /** Absolute case directory. */
  dir: string;
}

export interface LoadedSuite {
  manifest: SuiteManifest;
  /** Absolute suite directory. */
  dir: string;
  cases: LoadedCase[];
}

export class SuiteValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(`${message}\n  ${issues.join("\n  ")}`);
    this.name = "SuiteValidationError";
  }
}

function formatIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}: ${i.path.join(".") || "<root>"}: ${i.message}`);
}

async function readYaml(file: string, label: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return parseYaml(text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SuiteValidationError(`Invalid YAML in ${label}`, [
      `${label}: Invalid YAML: ${msg.split("\n")[0] ?? msg}`,
    ]);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err: unknown) {
    void err;
    return false;
  }
}

/** Placeholder written by the incident template; a case still carrying it has not been filled in. */
export const PLACEHOLDER_CLASS = "replace-me";

/**
 * Check `expected.findingClasses` and `expected.lenses` against the lens registry (plus the suite's extras), so a typo
 * fails at load time and in --dry instead of as "blocked for the wrong reason" in a paid run.
 */
export function registryIssues(spec: CaseSpec, file: string, manifest?: SuiteManifest): string[] {
  const issues: string[] = [];
  const classes = new Set([...listLenses().flatMap((l) => l.classes), ...(manifest?.extraFindingClasses ?? [])]);
  const lenses = new Set([...lensIds(), ...(manifest?.extraLenses ?? [])]);
  for (const c of spec.expected.findingClasses ?? []) {
    if (c === PLACEHOLDER_CLASS) {
      issues.push(`${file}: expected.findingClasses: "${PLACEHOLDER_CLASS}" is the template placeholder; fill it in`);
    } else if (!classes.has(c)) {
      issues.push(
        `${file}: expected.findingClasses: unknown class "${c}" (not emitted by any registered lens; add it to suite.yml extraFindingClasses if a custom lens raises it)`,
      );
    }
  }
  for (const l of spec.expected.lenses ?? []) {
    if (!lenses.has(l)) issues.push(`${file}: expected.lenses: unknown lens "${l}"`);
  }
  return issues;
}

export function parseSuiteManifest(input: unknown, file = "suite.yml"): SuiteManifest {
  const r = suiteSchema.safeParse(input);
  if (!r.success) throw new SuiteValidationError(`Invalid suite manifest ${file}`, formatIssues(file, r.error));
  return r.data;
}

export function parseCase(input: unknown, file = "case.yml"): CaseSpec {
  const r = caseSchema.safeParse(input);
  if (!r.success) throw new SuiteValidationError(`Invalid eval case ${file}`, formatIssues(file, r.error));
  return r.data;
}

/**
 * Load and validate a suite directory. Every problem across every case is collected before throwing, so one run
 * reports all broken cases. Referenced fixture directories and diff files must exist.
 */
export async function loadSuite(suiteDir: string): Promise<LoadedSuite> {
  const dir = resolve(suiteDir);
  const manifestFile = join(dir, "suite.yml");
  if (!(await exists(manifestFile))) {
    throw new SuiteValidationError(`Not an eval suite: ${dir}`, ["suite.yml not found"]);
  }
  const issues: string[] = [];
  let manifest: SuiteManifest | undefined;
  try {
    manifest = parseSuiteManifest(await readYaml(manifestFile, "suite.yml"), "suite.yml");
  } catch (err: unknown) {
    if (err instanceof SuiteValidationError) issues.push(...err.issues);
    else throw err;
  }

  const cases: LoadedCase[] = [];
  const seen = new Map<string, string>();
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  entries.sort();
  for (const name of entries) {
    const caseDir = join(dir, name);
    const caseFile = join(caseDir, "case.yml");
    if (!(await exists(caseFile))) continue;
    const rel = `${name}/case.yml`;
    let spec: CaseSpec;
    try {
      spec = parseCase(await readYaml(caseFile, rel), rel);
    } catch (err: unknown) {
      if (err instanceof SuiteValidationError) {
        issues.push(...err.issues);
        continue;
      }
      throw err;
    }
    issues.push(...registryIssues(spec, rel, manifest));
    const dup = seen.get(spec.id);
    if (dup) issues.push(`${rel}: id: duplicate case id "${spec.id}" (also in ${dup})`);
    seen.set(spec.id, rel);
    const paths =
      spec.source.type === "fixture"
        ? ([
            ["base", spec.source.base, "directory"],
            ["head", spec.source.head, "directory"],
          ] as const)
        : spec.source.type === "diff"
          ? ([["diff", spec.source.diff, "file"]] as const)
          : [];
    for (const [key, p, what] of paths) {
      try {
        if ((await confinedPath(join(caseDir, p), caseDir, `source.${key} ${p}`)) === null) {
          issues.push(`${rel}: source.${key}: ${what} ${p} not found`);
        }
      } catch (err: unknown) {
        if (!(err instanceof FixtureError)) throw err;
        issues.push(`${rel}: source.${key}: ${err.message}`);
      }
    }
    cases.push({ spec, dir: caseDir });
  }

  if (issues.length > 0 || !manifest) throw new SuiteValidationError(`Invalid eval suite ${dir}`, issues);
  if (cases.length === 0) throw new SuiteValidationError(`Invalid eval suite ${dir}`, ["suite has no cases"]);
  return { manifest, dir, cases };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge of policy fragments: objects merge key by key, arrays and scalars from later fragments replace. */
export function mergePolicyFragments(...fragments: Array<Record<string, unknown> | undefined>): PolicyInput {
  const out: Record<string, unknown> = {};
  for (const frag of fragments) {
    if (!frag) continue;
    for (const [k, v] of Object.entries(frag)) {
      const prev = out[k];
      out[k] = isPlainObject(prev) && isPlainObject(v) ? mergePolicyFragments(prev, v) : v;
    }
  }
  return out as PolicyInput;
}

/** The policy input for one case: suite defaults, then `defaults.models`, then the case, then the run override. */
export function casePolicyInput(
  suite: SuiteManifest,
  spec: CaseSpec,
  override?: Record<string, unknown> | PolicyInput,
): PolicyInput {
  const models = suite.defaults?.models ? { models: suite.defaults.models } : undefined;
  return mergePolicyFragments(
    suite.defaults?.policy,
    models,
    spec.policy,
    override as Record<string, unknown> | undefined,
  );
}
