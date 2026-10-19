/**
 * Minimal, segment-aware glob matcher for conditional-lens gating. Private to the panel module.
 *   `**`  zero or more whole path segments
 *   `*`   any run of characters within one segment
 *   `?`   one character within a segment
 * Everything else is literal. Matching is anchored at the repo root, so `*.tsx` only matches root files; use
 * `**\/*.tsx` for "anywhere". Because `*` never crosses `/`, "author" never matches a "**\/auth/**" pattern.
 */

const segCache = new Map<string, RegExp>();

function segmentRegex(seg: string): RegExp {
  let re = segCache.get(seg);
  if (!re) {
    const body = seg
      .split("")
      .map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    re = new RegExp(`^${body}$`);
    segCache.set(seg, re);
  }
  return re;
}

function split(p: string): string[] {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s.length > 0);
}

function matchSegments(pat: string[], pi: number, path: string[], si: number): boolean {
  while (pi < pat.length) {
    const p = pat[pi] as string;
    if (p === "**") {
      // Collapse consecutive globstars, then try every possible split.
      let next = pi + 1;
      while (pat[next] === "**") next++;
      if (next === pat.length) return true;
      for (let k = si; k <= path.length; k++) if (matchSegments(pat, next, path, k)) return true;
      return false;
    }
    const s = path[si];
    if (s === undefined || !segmentRegex(p).test(s)) return false;
    pi++;
    si++;
  }
  return si === path.length;
}

export function matchGlob(pattern: string, path: string): boolean {
  return matchSegments(split(pattern), 0, split(path), 0);
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
