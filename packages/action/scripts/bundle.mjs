// Builds dist/index.js, the file GitHub runs (action.yml -> runs.main), and dist/git-wrapper.js. Both are committed;
// CI fails on a stale copy.
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
  // index.js is the Action; git-wrapper.js is the `ms-git` guard the Claude Code CLI runner (`runner: cli`) launches.
  // provider-anthropic resolves it as new URL("./git-wrapper.js", import.meta.url), i.e. next to index.js.
  entryPoints: { index: "src/main.ts", "git-wrapper": "../provider-anthropic/dist/git-wrapper.js" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  alias: { "@merge-safely/store-sqlite": "./src/stubs/store-sqlite.ts" },
  external: ["better-sqlite3"],
  inject: ["./src/stubs/import-meta-url.ts"],
  define: { "import.meta.url": "import_meta_url" },
});

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
