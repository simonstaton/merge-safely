/**
 * File names that commonly hold credentials. Never read, listed, searched or blamed, in any mode,
 * even when tracked: the reviewer has no need for their contents and a finding could leak them.
 */
const SENSITIVE_BASENAME: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials.*\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

export function isSensitivePath(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return SENSITIVE_BASENAME.some((re) => re.test(base));
}

/** rg globs excluding the same names (placed after any model glob, since the last match wins). */
export const SENSITIVE_RG_GLOBS = [
  "!.env",
  "!.env.*",
  "!*.pem",
  "!*.key",
  "!id_rsa*",
  "!*.p12",
  "!*.pfx",
  "!credentials*.json",
  "!.netrc",
  "!.npmrc",
  "!.pypirc",
];

export function hasGitSegment(rel: string): boolean {
  return rel.split("/").some((s) => s.toLowerCase() === ".git");
}

/** A path the tools must never surface: under .git or credential-shaped. */
export function isHiddenPath(rel: string): boolean {
  return hasGitSegment(rel) || isSensitivePath(rel);
}
