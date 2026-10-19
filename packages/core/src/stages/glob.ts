// Minimal, dependency-free path glob matcher used for policy path patterns.
//
// Semantics (`/`-separated, whole segments only, case-insensitive by default):
// - `**` as a whole segment matches zero or more path segments (including dot segments), except that a
//   trailing `/**` requires at least one segment ("everything inside this directory", as in gitignore).
// - `*` matches any run of characters inside one segment; `?` matches one character inside one segment.
// - `{a,b}` matches one of the comma-separated alternatives inside one segment (alternatives may use `*`/`?`).
// - A `**` that is not a whole segment (e.g. `a**b`) behaves like `*`.
// - A pattern without a `/` matches the basename anywhere, i.e. `*.sql` behaves like `**/*.sql`.
// - A trailing `/` means a directory: `docs/` behaves like `**/docs/**`, `site/docs/` like `site/docs/**`.
// - A leading `./` or `/` on either side is ignored; paths are never matched by substring, so
//   `**/auth/**` matches `src/auth/login.ts` but not `src/author/bio.ts`.
//
// Matching is linear-ish: each segment is matched with a greedy wildcard algorithm (O(n*m) worst case,
// no regex backtracking) and segment sequences are matched with a memoised walk (O(segments^2)).

export interface MatchOptions {
  /** Default true: `src/Auth/x.ts` matches `**\/auth/**`. Repos with PascalCase dirs need this for critical paths. */
  caseInsensitive?: boolean;
}

/** One path segment pattern: a set of wildcard alternatives (from brace expansion), or a globstar. */
type Segment = { kind: "globstar" } | { kind: "any-one" } | { kind: "wild"; alts: string[] };

const MAX_BRACE_ALTERNATIVES = 256;
const compiled = new Map<string, Segment[]>();

function normalise(p: string): string {
  let out = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  return out;
}

/** Expand `{a,b}` groups in one segment into plain wildcard alternatives (capped). Unclosed `{` is literal. */
export function expandBraces(seg: string): string[] {
  const open = seg.indexOf("{");
  if (open === -1) return [seg];
  const close = seg.indexOf("}", open + 1);
  if (close === -1) return [seg];
  const head = seg.slice(0, open);
  const alts = seg.slice(open + 1, close).split(",");
  const tails = expandBraces(seg.slice(close + 1));
  const out: string[] = [];
  for (const a of alts) {
    for (const t of tails) {
      out.push(head + a + t);
      if (out.length >= MAX_BRACE_ALTERNATIVES) return out;
    }
  }
  return out;
}

/**
 * Greedy wildcard match of one segment (`*` and `?` only). Classic two-pointer algorithm that remembers
 * only the last `*`, so it never backtracks exponentially: `*a*a*a*a*a*b` against 10k chars is instant.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const pc = pattern.charAt(p);
    if (p < pattern.length && (pc === "?" || pc === text.charAt(t)) && pc !== "*") {
      p++;
      t++;
    } else if (p < pattern.length && pc === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern.charAt(p) === "*") p++;
  return p === pattern.length;
}

function compile(pattern: string, ci: boolean): Segment[] {
  const key = `${ci ? "i" : "s"}:${pattern}`;
  const cached = compiled.get(key);
  if (cached) return cached;
  let p = normalise(ci ? pattern.toLowerCase() : pattern);
  const dirOnly = p.endsWith("/") && p.length > 1;
  if (dirOnly) p = p.replace(/\/+$/, "");
  if (!p.includes("/") && p !== "**") p = `**/${p}`;
  if (dirOnly) p = `${p}/**`;
  const segs: Segment[] = [];
  for (const raw of p.split("/")) {
    if (raw === "**") {
      // Collapse consecutive globstars: they are equivalent to one.
      if (segs[segs.length - 1]?.kind !== "globstar") segs.push({ kind: "globstar" });
    } else {
      // `a**b` is the same as `a*b`; collapsing star runs also keeps wildcardMatch cheap.
      segs.push({ kind: "wild", alts: expandBraces(raw).map((a) => a.replace(/\*{2,}/g, "*")) });
    }
  }
  // A trailing `/**` means "inside this directory": it needs at least one more segment, so
  // `**/dist/**` matches `dist/a.js` but not a file named `dist`.
  if (segs.length > 1 && segs[segs.length - 1]?.kind === "globstar")
    segs.splice(segs.length - 1, 0, { kind: "any-one" });
  if (compiled.size >= 1000) compiled.clear();
  compiled.set(key, segs);
  return segs;
}

function matchSegment(seg: Segment, value: string): boolean {
  if (seg.kind === "wild") return seg.alts.some((a) => wildcardMatch(a, value));
  return value.length > 0;
}

/** Memoised walk over (pattern index, path index): each state is computed once. */
function matchSegments(pat: Segment[], parts: string[]): boolean {
  const width = parts.length + 1;
  const memo = new Uint8Array((pat.length + 1) * width); // 0 unknown, 1 false, 2 true
  const visit = (pi: number, si: number): boolean => {
    const key = pi * width + si;
    const hit = memo[key];
    if (hit) return hit === 2;
    let result: boolean;
    const seg = pat[pi];
    if (seg === undefined) {
      result = si === parts.length;
    } else if (seg.kind === "globstar") {
      result = visit(pi + 1, si) || (si < parts.length && visit(pi, si + 1));
    } else {
      const part = parts[si];
      result = part !== undefined && matchSegment(seg, part) && visit(pi + 1, si + 1);
    }
    memo[key] = result ? 2 : 1;
    return result;
  };
  return visit(0, 0);
}

/** True when `path` matches the glob `pattern` (see module doc for semantics). */
export function matchPath(pattern: string, path: string, opts: MatchOptions = {}): boolean {
  if (pattern.trim() === "") return false;
  const ci = opts.caseInsensitive ?? true;
  const p = normalise(ci ? path.toLowerCase() : path).replace(/\/+$/, "");
  if (p === "") return false;
  return matchSegments(compile(pattern, ci), p.split("/"));
}

/** The first pattern in `patterns` that matches `path`, or undefined. */
export function firstMatch(patterns: readonly string[], path: string, opts?: MatchOptions): string | undefined {
  return patterns.find((pat) => matchPath(pat, path, opts));
}

/** True when any pattern matches. */
export function matchAny(patterns: readonly string[], path: string, opts?: MatchOptions): boolean {
  return firstMatch(patterns, path, opts) !== undefined;
}
