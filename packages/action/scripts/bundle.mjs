// Builds dist/index.js, the single file GitHub runs (action.yml -> runs.main). Committed; CI fails on a stale copy.
//
//   esbuild src/main.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/index.js
//
// plus three adjustments a CommonJS single-file bundle needs:
// - @merge-safely/store-sqlite is aliased to a stub: the Action stores verdicts in the check run, and the real package
//   loads the native better-sqlite3 addon at import time (marked external too, so it is never inlined).
// - `import.meta.url` (absent in CJS) is defined as the bundle's own file URL.
// - dist/package.json sets "type": "commonjs", because this package is "type": "module".
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  logOverride: { "import-is-undefined": "silent" }, // createGate is looked up at runtime until the orchestrator lands
  alias: { "@merge-safely/store-sqlite": "./src/stubs/store-sqlite.ts" },
  external: ["better-sqlite3"],
  inject: ["./src/stubs/import-meta-url.ts"],
  define: { "import.meta.url": "import_meta_url" },
});

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
