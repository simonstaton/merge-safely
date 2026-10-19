/**
 * Bundle-time shim (esbuild `--inject` + `--define:import.meta.url=import_meta_url`). The bundle is CommonJS, where
 * `import.meta` does not exist; dependencies that resolve files next to themselves get the bundle's own URL instead.
 */
import { pathToFileURL } from "node:url";

export const import_meta_url = pathToFileURL(__filename).href;
