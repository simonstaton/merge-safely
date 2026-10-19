import type { Policy } from "../policy/schema.js";
import type { Change, ChangedFile, Tier, TierLevel } from "../types.js";
import { matchAny, matchPath } from "./glob.js";

/**
 * Score weights. The composite score is
 *
 *   score = round(min(100,
 *       45 * loc     / (loc + 300)          // lines added + deleted, ignorePaths excluded
 *     + 20 * files   / (files + 15)         // changed files, ignorePaths excluded
 *     + 20 * (mods-1)/ ((mods-1) + 4)      // module spread: distinct first-two directory segments
 *     + 10 * [any critical path hit]
 *     +  5 * [any feature-flag read removed]))
 *
 * Each term is a saturating curve x/(x+h) that is non-decreasing in its input, so the score is monotonic:
 * adding lines, files, modules, critical hits or flag removals never lowers it. The half-saturation
 * constants put a ~30 line / 3 file / 1 module change around 7 (tier 0 under default thresholds),
 * ~200 LOC / 8 files / 3 modules around 32 (tier 1), ~800 / 25 / 5 around 55 (tier 2), and only very
 * large, sprawling changes reach 80 on size alone.
 *
 * Level: score < t1 -> 0, < t2 -> 1, < t3 -> 2, else 3. A critical path hit, or a flag removal when
 * `policy.tiers.flagRemovalIsCritical`, forces level 3 regardless of score.
 */
export const TIER_WEIGHTS = { loc: 45, files: 20, modules: 20, critical: 10, flags: 5 } as const;
const HALF = { loc: 300, files: 15, modules: 4 } as const;

const saturate = (x: number, half: number): number => (x <= 0 ? 0 : x / (x + half));

/** Module key for a path: the first two directory segments ("packages/core/src/x.ts" -> "packages/core"). */
export function moduleOf(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length === 0 ? "." : dirs.slice(0, 2).join("/");
}

function compileFlagPatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, "g"));
    } catch (err: unknown) {
      // An invalid policy regex must not crash tiering; it simply never matches.
      void err;
    }
  }
  return out;
}

interface DiffRuns {
  /** Removed lines (marker stripped). */
  removed: string[];
  /** Added lines (marker stripped). */
  added: string[];
  /** Consecutive removed lines within a hunk, joined with "\n". */
  removedRuns: string[];
  /** Consecutive added lines within a hunk, joined with "\n". */
  addedRuns: string[];
}

/**
 * Parse unified diff hunk text. Lines before the first `@@` of each file section (`diff --git`, `index`,
 * `--- a/x`, `+++ b/x`) are headers and skipped; inside a hunk every `-`/`+` line is content, so a removed
 * SQL comment such as `-- a/b` is never mistaken for a header.
 */
export function diffLines(patch: string): DiffRuns {
  const out: DiffRuns = { removed: [], added: [], removedRuns: [], addedRuns: [] };
  let inHunk = false;
  let run: { kind: "-" | "+"; lines: string[] } | null = null;
  const flush = () => {
    if (run) (run.kind === "-" ? out.removedRuns : out.addedRuns).push(run.lines.join("\n"));
    run = null;
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const kind = line.startsWith("-") ? "-" : line.startsWith("+") ? "+" : null;
    if (kind === null) {
      flush();
      continue;
    }
    const content = line.slice(1);
    (kind === "-" ? out.removed : out.added).push(content);
    if (run && run.kind !== kind) flush();
    if (!run) run = { kind, lines: [] };
    run.lines.push(content);
  }
  flush();
  return out;
}

/**
 * The matched call plus its argument list up to the balancing paren. Works across the newlines of a
 * joined run; an unbalanced call (argument list continues past the run) is returned up to the run end.
 */
function extractCall(text: string, start: number, matchText: string): string {
  let end = start + matchText.length;
  let depth = (matchText.match(/\(/g) ?? []).length - (matchText.match(/\)/g) ?? []).length;
  while (end < text.length && depth > 0) {
    const ch = text.charAt(end);
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    end++;
  }
  return text.slice(start, end);
}

const normaliseCall = (s: string): string => s.replace(/\s+/g, "").replace(/'|`/g, '"');

/**
 * Feature-flag reads removed by a file's patch. Consecutive removed lines of a hunk are joined before
 * matching, so a call split across lines (`isEnabled(\n  "checkout-v2"\n)`) is seen whole. A removal
 * counts unless a run of added lines in the same file contains the same call (moved or reformatted).
 */
export function findFlagRemovals(file: ChangedFile, patterns: RegExp[]): string[] {
  if (!file.patch || patterns.length === 0) return [];
  const { removedRuns, addedRuns } = diffLines(file.patch);
  if (removedRuns.length === 0) return [];
  const addedNorm = addedRuns.map(normaliseCall);
  const out = new Set<string>();
  for (const text of removedRuns) {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (m[0].length === 0) continue;
        const call = extractCall(text, m.index ?? 0, m[0]);
        const norm = normaliseCall(call);
        if (!addedNorm.some((a) => a.includes(norm))) out.add(call.replace(/\s*\n\s*/g, "").trim());
      }
    }
  }
  return [...out].map((call) => `${file.path}: ${call}`);
}

function levelFor(score: number, t: Policy["tiers"]["thresholds"]): TierLevel {
  if (score >= t.t3) return 3;
  if (score >= t.t2) return 2;
  if (score >= t.t1) return 1;
  return 0;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Classify a change into a risk tier. Pure; see TIER_WEIGHTS for the formula. */
export function tier(change: Change, policy: Policy): Tier {
  const { tiers } = policy;
  const scored = change.files.filter((f) => !matchAny(tiers.ignorePaths, f.path));
  const ignored = change.files.length - scored.length;

  let loc = scored.reduce((n, f) => n + Math.max(0, f.additions) + Math.max(0, f.deletions), 0);
  let files = scored.length;
  const reasons: string[] = [];
  // The provider may truncate the file list (GitHub caps it). Unseen files may hit critical paths, so a
  // truncated list fails closed to tier 3; size never scores less than the change stats say.
  const truncated = change.stats.files > change.files.length;
  if (truncated) {
    files = Math.max(files, change.stats.files - ignored);
    loc = Math.max(loc, change.stats.additions + change.stats.deletions);
    reasons.push(`file list truncated (${change.files.length} of ${change.stats.files} files visible)`);
  }
  const modules = new Set(scored.map((f) => moduleOf(f.path))).size;

  // Critical paths: check the current and previous path of every file (renames out of a critical dir count).
  const hitPatterns: string[] = [];
  const hitExamples = new Map<string, string[]>();
  for (const f of change.files) {
    const paths = f.previousPath && f.previousPath !== f.path ? [f.path, f.previousPath] : [f.path];
    for (const pattern of tiers.criticalPaths) {
      for (const p of paths) {
        if (!matchPath(pattern, p)) continue;
        if (!hitExamples.has(pattern)) {
          hitExamples.set(pattern, []);
          hitPatterns.push(pattern);
        }
        const ex = hitExamples.get(pattern);
        if (ex && !ex.includes(p)) ex.push(p);
      }
    }
  }

  const flagPatterns = compileFlagPatterns(tiers.flagReadPatterns);
  const flagRemovals = change.files.flatMap((f) => findFlagRemovals(f, flagPatterns));
  // Critical files whose patch the provider did not supply (too large, binary): flag removals unchecked.
  const unpatchedCritical = change.files.filter(
    (f) => f.patch === undefined && [...hitExamples.values()].some((ex) => ex.includes(f.path)),
  );

  const raw =
    TIER_WEIGHTS.loc * saturate(loc, HALF.loc) +
    TIER_WEIGHTS.files * saturate(files, HALF.files) +
    TIER_WEIGHTS.modules * saturate(modules - 1, HALF.modules) +
    (hitPatterns.length > 0 ? TIER_WEIGHTS.critical : 0) +
    (flagRemovals.length > 0 ? TIER_WEIGHTS.flags : 0);
  const score = Math.round(Math.min(100, Math.max(0, raw)));

  const byScore = levelFor(score, tiers.thresholds);
  const forcedByCritical = hitPatterns.length > 0;
  const forcedByFlags = flagRemovals.length > 0 && tiers.flagRemovalIsCritical;
  const level: TierLevel = forcedByCritical || forcedByFlags || truncated ? 3 : byScore;

  reasons.unshift(
    `size: ${plural(loc, "line")} changed across ${plural(files, "file")} in ${plural(modules, "module")} (score ${score})`,
  );
  if (ignored > 0) reasons.push(`${plural(ignored, "file")} ignored for sizing (policy.tiers.ignorePaths)`);
  for (const pattern of hitPatterns) {
    const ex = hitExamples.get(pattern) ?? [];
    const more = ex.length > 1 ? `, +${ex.length - 1} more` : "";
    reasons.push(`touches critical path ${pattern} (${ex[0] ?? "?"}${more})`);
  }
  for (const r of flagRemovals.slice(0, 5)) reasons.push(`removes feature-flag read ${r}`);
  if (flagRemovals.length > 5) reasons.push(`removes ${flagRemovals.length - 5} more feature-flag reads`);
  for (const f of unpatchedCritical.slice(0, 5)) {
    reasons.push(`critical-path file ${f.path} has no patch; feature-flag removals not checked`);
  }
  if (unpatchedCritical.length > 5) {
    reasons.push(`${unpatchedCritical.length - 5} more critical-path files have no patch`);
  }

  const t = tiers.thresholds;
  if (forcedByCritical || forcedByFlags || truncated) {
    const why = [
      forcedByCritical ? "critical path hit" : "",
      forcedByFlags ? "feature-flag removal" : "",
      truncated ? "truncated file list" : "",
    ]
      .filter(Boolean)
      .join(" and ");
    reasons.push(`tier 3 forced by ${why} (score alone would be tier ${byScore})`);
  } else if (level === 0) {
    reasons.push(`score ${score} is below t1 (${t.t1}): tier 0`);
  } else {
    const threshold = level === 3 ? t.t3 : level === 2 ? t.t2 : t.t1;
    reasons.push(`score ${score} reaches t${level} (${threshold}): tier ${level}`);
  }

  return {
    level,
    score,
    factors: { loc, files, modules, criticalPathHits: hitPatterns, flagRemovals },
    reasons,
  };
}
