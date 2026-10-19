/**
 * Minimal glob matching: `**` spans any number of path segments, `*` matches within a segment,
 * `?` matches one non-separator character. Everything else is literal.
 * A glob without `/` matches against the basename at any depth (gitignore-style), so `*.ts` finds all TS files.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**/` -> zero or more segments; trailing `**` -> anything.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
