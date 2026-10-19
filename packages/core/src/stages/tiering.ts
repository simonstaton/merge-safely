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

const HEADER_RE = /^(?:---|\+\+\+) (?:a\/|b\/|\/dev\/null)/;

/** Removed and added lines of a unified diff hunk text, with the +/- marker stripped. */
export function diffLines(patch: string): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (HEADER_RE.test(line)) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  return { removed, added };
}

/** The matched call plus its argument list up to the balancing paren on the same line. */
function extractCall(line: string, start: number, matchText: string): string {
  let end = start + matchText.length;
  let depth = (matchText.match(/\(/g) ?? []).length - (matchText.match(/\)/g) ?? []).length;
  while (end < line.length && depth > 0) {
    const ch = line.charAt(end);
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    end++;
  }
  return line.slice(start, end);
}

const normaliseCall = (s: string): string => s.replace(/\s+/g, "").replace(/'|`/g, '"');

/**
 * Feature-flag reads removed by a file's patch. A removed line counts when it matches any flag pattern,
 * unless an added line in the same file contains the same call (moved or reformatted, not removed).
 */
export function findFlagRemovals(file: ChangedFile, patterns: RegExp[]): string[] {
  if (!file.patch || patterns.length === 0) return [];
  const { removed, added } = diffLines(file.patch);
  if (removed.length === 0) return [];
  const addedNorm = added.map(normaliseCall);
  const out = new Set<string>();
  for (const line of removed) {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (m[0].length === 0) continue;
        const call = extractCall(line, m.index ?? 0, m[0]).trim();
        const norm = normaliseCall(call);
        if (!addedNorm.some((a) => a.includes(norm))) out.add(call);
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
  // The provider may truncate the file list (GitHub caps it). Never score less than the change stats say.
  if (change.stats.files > change.files.length) {
    files = Math.max(files, change.stats.files - ignored);
    loc = Math.max(loc, change.stats.additions + change.stats.deletions);
    reasons.push(`file list truncated (${change.files.length} of ${change.stats.files} listed); sized from stats`);
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
  const level: TierLevel = forcedByCritical || forcedByFlags ? 3 : byScore;

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

  const t = tiers.thresholds;
  if (forcedByCritical || forcedByFlags) {
    const why = [forcedByCritical ? "critical path hit" : "", forcedByFlags ? "feature-flag removal" : ""]
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
