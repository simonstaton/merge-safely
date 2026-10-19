/**
 * Bundle-time stand-in for @merge-safely/store-sqlite (esbuild `--alias`, see package.json "bundle").
 *
 * The Action stores verdicts in the check run, so it never opens SQLite. The real package imports the native
 * `better-sqlite3` addon at load time, which a committed single-file bundle cannot carry; aliasing it here keeps
 * the CLI's gate wiring importable without the addon. Asking for SQLite inside the Action fails with the fix.
 */
export const SCHEMA_VERSION = 0;
export const DEFAULT_COMPACT_OLDER_THAN_MS = 0;

export function sqliteStores(_opts: { path: string }): never {
  throw new Error("the sqlite store is not available in the GitHub Action; use store: checkrun");
}
