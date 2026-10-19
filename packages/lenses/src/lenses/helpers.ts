import type { LensFileInfo, LensPromptInput } from "../types.js";

/** Render a numbered checklist. */
export function checklist(items: readonly string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function capHits(files: readonly LensFileInfo[], max: number, pick: (f: LensFileInfo) => string): string[] {
  // Only exact (safe-charset) paths are named in trusted text; the rest are counted and left to the files block.
  const exact = files.filter((f) => f.exact).map(pick);
  const shown = exact.slice(0, max);
  const more = files.length - shown.length;
  return more > 0 ? [...shown, `${more} more (see the changed-files block)`] : shown;
}

/** Changed paths matching a pattern, capped, for "start with these files" hints. */
export function pathsMatching(input: LensPromptInput, pattern: RegExp, max = 8): string[] {
  return capHits(
    input.files.filter((f) => f.status !== "removed" && pattern.test(f.path)),
    max,
    (f) => f.path,
  );
}

/** Removed or renamed-away paths, capped. */
export function removedPaths(input: LensPromptInput, max = 8): string[] {
  return capHits(
    input.files.filter((f) => f.status === "removed" || f.status === "renamed"),
    max,
    (f) => f.previousPath ?? f.path,
  );
}

/** One line naming changed files worth starting from, or nothing. */
export function startWith(label: string, paths: readonly string[]): string[] {
  return paths.length > 0 ? [`${label}: ${paths.join(", ")}.`] : [];
}

/** How this lens may use commands, given the policy allowlist. */
export function commandHint(input: LensPromptInput, use: string): string {
  return input.allowedCommands.length > 0
    ? `Run the allowed commands where they settle a question: ${use}. Record each command and its result in evidence.`
    : `No commands may be run, so ${use} by reading code and tests; say in evidence that the conclusion is from reading.`;
}

/** Compose a lens focus block: tools line, checklist, extra hints, evidence demand. */
export function focusBlock(parts: {
  tools: string;
  checks: readonly string[];
  hints?: readonly string[];
  evidence: string;
}): string {
  return [
    `Tools: ${parts.tools}`,
    "Checklist:",
    checklist(parts.checks),
    ...(parts.hints ?? []),
    `Evidence per finding: ${parts.evidence}`,
  ].join("\n");
}

export const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$|(^|\/)(components?|ui|styles?|pages|views)\//i;
export const MIGRATION_PATH = /(^|\/)(migrations?|migrate|db\/schema|schema\.(sql|prisma|rb))(\/|$|\.)|\.sql$/i;
export const FLAG_CONFIG_PATH = /(^|\/)(flags?|feature[-_]?flags?|features?|config|settings)(\/|\.|$)/i;
// Whole path segments (optionally followed by - _ or .), so "author/" and "docs/authors.md" do not match "auth".
export const SECURITY_PATH =
  /(^|\/)(auth|authn|authz|authentication|authorization|oauth|sso|saml|login|sessions?|permissions?|acl|rbac|crypto|secrets?|middleware|webhooks?)([-_./]|$)/i;
export const DATA_PATH = /(^|\/)(db|dal|repositor(y|ies)|models?|queries|sql|orm|dao)(\/|\.|$)|\.sql$/i;
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.\w+$/i;
