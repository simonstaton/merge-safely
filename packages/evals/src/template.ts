/**
 * Incident template: scaffold a suite and new cases so every incident becomes an eval (design section 10:
 * "the suite grows with every incident and the CLI has a template for adding one").
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stringify as yamlString } from "yaml";
import { type CaseKind, caseSchema } from "./suite.js";

export interface ScaffoldCaseOptions {
  id: string;
  kind: CaseKind;
  title: string;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
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

const KIND_DEFAULTS: Record<CaseKind, { decision: "pass" | "block"; hint: string }> = {
  incident: { decision: "block", hint: "an incident that reached production: the gate must block it" },
  clean: { decision: "pass", hint: "a known-good change: the gate must not block it (measures false blocks)" },
  regression: { decision: "block", hint: "a behaviour the gate must keep (tiering, triage, a specific catch)" },
};

export function caseTemplate(opts: ScaffoldCaseOptions): string {
  const d = KIND_DEFAULTS[opts.kind];
  const blockOnly =
    d.decision === "block"
      ? `  # At least one finding must carry one of these classes (see the lens table in docs/design.md section 9).
  findingClasses: [replace-me]
  # ...and point at one of these files (paths relative to the repo root of the fixture).
  # files: [src/path/to/the/bug.ts]
`
      : "";
  return `# Eval case: ${opts.title}
# Kind "${opts.kind}": ${d.hint}.
id: ${opts.id}
title: ${JSON.stringify(opts.title)}
kind: ${opts.kind}

expected:
  decision: ${d.decision}
  # The tier the change must land in (0 trivial .. 3 critical). Most incidents are tiering failures, so pin it.
  # tier: 3
  # Deterministic triage outcome; checked by --dry runs too.
  # triage: review
  # Lenses that must be seated for this change.
  # lenses: [rollout]
${blockOnly}
# Where the change comes from. A fixture holds two minimal trees: base/ (before) and head/ (after).
source:
  type: fixture
  base: base/
  head: head/
# Alternatives:
#   source: { type: diff, diff: change.diff }
#   source: { type: github, repo: owner/name, pr: 123, headSha: <the SHA that merged> }   # needs a token

# The PR metadata the author wrote. Untrusted: it reaches reviewers only inside delimited data blocks.
change:
  title: ${JSON.stringify(opts.title)}
  body: ""
  # author: someone
  # labels: []

# Optional policy overrides for this case only (merged over the suite defaults).
# policy:
#   tiers: { criticalPaths: ["**/jobs/**"] }

notes: |
  What happened, how it was found, and what a reviewer should have noticed.
  Link the incident record if you have one (no customer data, no secrets).
`;
}

export const CASE_README = `# Reducing an incident to an eval fixture

1. Start from the merged change that caused the incident (the PR, or \`git show <sha>\`).
2. Copy only the files the change touched into \`head/\` as they were after the change, and the same files
   before the change into \`base/\`. Keep the repository-relative paths: tiering matches paths, so
   \`services/api/src/jobs/backfill.ts\` must stay exactly that.
3. Add the smallest amount of surrounding code a reviewer needs to see the bug: the caller, the consumer that
   breaks, the flag registry that lacks the flag. A reviewer that cannot see the consumer cannot catch the break.
4. Strip everything else. Remove secrets, tokens, internal hostnames, customer names and any personal data;
   replace them with obvious placeholders. Keep the bug: the line that caused the incident must survive the
   reduction unchanged in spirit.
5. Fill in \`case.yml\`: the expected decision, tier, the finding classes that describe the bug and the file it
   lives in, and \`notes\` explaining the incident in two or three sentences.
6. Check it: \`merge-safely eval --suite <suite> --ids <id> --dry\` asserts the tier, triage and seated lenses
   without calling a model. Then run it for real against your configured models.

Empty \`base/\` means every file in \`head/\` is new. \`.gitkeep\` files are ignored.
`;

/** Write `<suiteDir>/suite.yml` if it does not exist yet. Returns true when it was created. */
export async function initSuite(
  suiteDir: string,
  opts: { name?: string; description?: string } = {},
): Promise<boolean> {
  const dir = resolve(suiteDir);
  const file = join(dir, "suite.yml");
  if (await exists(file)) return false;
  await mkdir(dir, { recursive: true });
  const manifest = {
    version: 1,
    name: opts.name ?? basename(dir),
    ...(opts.description ? { description: opts.description } : {}),
    gates: { minRecall: 0.8, maxFalseBlock: 0.1 },
  };
  await writeFile(
    file,
    `# Merge Safely eval suite. One case per subdirectory (case.yml + base/ + head/).\n${yamlString(manifest)}# defaults:\n#   policy: {}      # policy overrides for every case\n#   models: {}      # shorthand for policy.models\n`,
  );
  return true;
}

/**
 * Create `<suiteDir>/<id>/` with a commented case.yml, empty base/ and head/ trees and a README on reducing a real
 * incident to a minimal fixture. Refuses to overwrite an existing case.
 */
export async function scaffoldCase(suiteDir: string, opts: ScaffoldCaseOptions): Promise<ScaffoldResult> {
  const idCheck = caseSchema.innerType().shape.id.safeParse(opts.id);
  if (!idCheck.success) throw new Error(`invalid case id "${opts.id}": ${idCheck.error.issues[0]?.message ?? ""}`);
  const dir = join(resolve(suiteDir), opts.id);
  if (await exists(dir)) throw new Error(`case directory already exists: ${dir}`);
  await mkdir(join(dir, "base"), { recursive: true });
  await mkdir(join(dir, "head"), { recursive: true });
  const files = [
    join(dir, "case.yml"),
    join(dir, "README.md"),
    join(dir, "base", ".gitkeep"),
    join(dir, "head", ".gitkeep"),
  ];
  await writeFile(files[0] as string, caseTemplate(opts));
  await writeFile(files[1] as string, CASE_README);
  await writeFile(files[2] as string, "");
  await writeFile(files[3] as string, "");
  return { dir, files };
}
