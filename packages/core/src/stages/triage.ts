import type { Policy } from "../policy/schema.js";
import type { Change, ChangedFile, Tier } from "../types.js";
import { matchAny } from "./glob.js";

export type TriageResult = { decision: "auto-pass"; reason: string } | { decision: "review"; reason: string };

/** Every path a file touches: its current path and, for renames/copies, where it came from. */
function pathsOf(f: ChangedFile): string[] {
  return f.previousPath && f.previousPath !== f.path ? [f.path, f.previousPath] : [f.path];
}

function allMatch(files: ChangedFile[], patterns: string[]): boolean {
  return files.every((f) => pathsOf(f).every((p) => matchAny(patterns, p)));
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Deterministic triage for tier 0 changes. Returns auto-pass for docs-only, assets-only and lockfile-only
 * changes (each behind its policy toggle), or for small changes within `triage.maxFiles` and
 * `triage.maxLines` with no critical path hit or flag removal. Everything else needs review.
 *
 * Size uses the raw file list (ignorePaths are a scoring aid, not a triage exemption), so a one-line change
 * that also rewrites a vendored directory is not waved through. Draft status never changes triage.
 */
export function triage(change: Change, tier: Tier, policy: Policy): TriageResult {
  if (tier.level !== 0) return { decision: "review", reason: `tier ${tier.level} always gets a review panel` };
  const files = change.files;
  if (files.length === 0) {
    return { decision: "review", reason: "change lists no files; refusing to auto-pass an empty or unknown diff" };
  }
  if (change.stats.files > files.length) {
    return {
      decision: "review",
      reason: `file list truncated (${files.length} of ${change.stats.files} listed); cannot triage what is not visible`,
    };
  }
  if (tier.factors.criticalPathHits.length > 0) {
    return { decision: "review", reason: `touches critical paths: ${tier.factors.criticalPathHits.join(", ")}` };
  }
  if ((tier.factors.flagRemovals ?? []).length > 0) {
    return { decision: "review", reason: "removes a feature-flag read" };
  }

  const t = policy.triage;
  if (t.docsOnlyAutoPass && allMatch(files, t.docsPatterns)) {
    return { decision: "auto-pass", reason: `docs-only change (${plural(files.length, "file")})` };
  }
  if (t.assetsOnlyAutoPass && allMatch(files, t.assetPatterns)) {
    return { decision: "auto-pass", reason: `assets-only change (${plural(files.length, "file")})` };
  }
  if (t.lockfileOnlyAutoPass && allMatch(files, t.lockfilePatterns)) {
    return { decision: "auto-pass", reason: `lockfile-only change (${plural(files.length, "file")})` };
  }

  const loc = files.reduce((n, f) => n + Math.max(0, f.additions) + Math.max(0, f.deletions), 0);
  if (files.length <= t.maxFiles && loc <= t.maxLines) {
    return {
      decision: "auto-pass",
      reason: `small change: ${plural(loc, "line")} across ${plural(files.length, "file")} (limits ${t.maxLines} lines, ${t.maxFiles} files)`,
    };
  }
  return {
    decision: "review",
    reason: `${plural(loc, "line")} across ${plural(files.length, "file")} exceeds triage limits (${t.maxLines} lines, ${t.maxFiles} files)`,
  };
}
