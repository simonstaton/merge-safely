// Minimal, dependency-free path glob matcher used for policy path patterns.
//
// Semantics (case-sensitive, `/`-separated, whole segments only):
// - `**` as a whole segment matches zero or more path segments (including dot segments), except that a
//   trailing `/**` requires at least one segment ("everything inside this directory", as in gitignore).
// - `*` matches any run of characters inside one segment; `?` matches one character inside one segment.
// - `{a,b}` matches one of the comma-separated alternatives inside one segment (alternatives may use `*`/`?`).
// - A `**` that is not a whole segment (e.g. `a**b`) behaves like `*`.
// - A pattern without a `/` matches the basename anywhere, i.e. `*.sql` behaves like `**/*.sql`.
// - A leading `./` or `/` on either side is ignored; paths are never matched by substring, so
//   `**/auth/**` matches `src/auth/login.ts` but not `src/author/bio.ts`.

type Segment = { kind: "globstar" } | { kind: "literal"; value: string } | { kind: "re"; re: RegExp };

const compiled = new Map<string, Segment[]>();

function normalise(p: string): string {
  let out = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  if (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out;
}

function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate one segment's glob syntax into a regex source (no anchors). */
function segmentSource(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const ch = seg.charAt(i);
    if (ch === "*") {
      while (seg.charAt(i + 1) === "*") i++;
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = seg.indexOf("}", i + 1);
      if (close === -1) {
        out += escapeRe(ch);
      } else {
        const alts = seg
          .slice(i + 1, close)
          .split(",")
          .map((a) => segmentSource(a));
        out += `(?:${alts.join("|")})`;
        i = close;
      }
    } else {
      out += escapeRe(ch);
    }
    i++;
  }
  return out;
}

function compile(pattern: string): Segment[] {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let p = normalise(pattern);
  if (!p.includes("/") && p !== "**") p = `**/${p}`;
  const segs: Segment[] = [];
  for (const raw of p.split("/")) {
    if (raw === "**") {
      // Collapse consecutive globstars: they are equivalent to one.
      if (segs[segs.length - 1]?.kind !== "globstar") segs.push({ kind: "globstar" });
    } else if (/[*?{]/.test(raw)) {
      segs.push({ kind: "re", re: new RegExp(`^${segmentSource(raw)}$`) });
    } else {
      segs.push({ kind: "literal", value: raw });
    }
  }
  // A trailing `/**` means "inside this directory": it needs at least one more segment, so
  // `**/dist/**` matches `dist/a.js` but not a file named `dist`.
  if (segs.length > 1 && segs[segs.length - 1]?.kind === "globstar") {
    segs.splice(segs.length - 1, 0, { kind: "re", re: /^.+$/ });
  }
  if (compiled.size >= 1000) compiled.clear();
  compiled.set(pattern, segs);
  return segs;
}

function matchSegment(seg: Segment, value: string): boolean {
  if (seg.kind === "literal") return seg.value === value;
  if (seg.kind === "re") return seg.re.test(value);
  return true;
}

function matchFrom(pat: Segment[], pi: number, parts: string[], si: number, memo: Map<number, boolean>): boolean {
  const key = pi * (parts.length + 1) + si;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let result: boolean;
  const seg = pat[pi];
  if (seg === undefined) {
    result = si === parts.length;
  } else if (seg.kind === "globstar") {
    // Zero segments, or consume one and stay on the globstar.
    result = matchFrom(pat, pi + 1, parts, si, memo) || (si < parts.length && matchFrom(pat, pi, parts, si + 1, memo));
  } else {
    const part = parts[si];
    result = part !== undefined && matchSegment(seg, part) && matchFrom(pat, pi + 1, parts, si + 1, memo);
  }
  memo.set(key, result);
  return result;
}

/** True when `path` matches the glob `pattern` (see module doc for semantics). */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern.trim() === "") return false;
  const p = normalise(path);
  if (p === "") return false;
  return matchFrom(compile(pattern), 0, p.split("/"), 0, new Map());
}

/** The first pattern in `patterns` that matches `path`, or undefined. */
export function firstMatch(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((pat) => matchPath(pat, path));
}

/** True when any pattern matches. */
export function matchAny(patterns: readonly string[], path: string): boolean {
  return firstMatch(patterns, path) !== undefined;
}
