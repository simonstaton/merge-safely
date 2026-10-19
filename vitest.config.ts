import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Resolve @merge-safely/* to package sources so tests never need a build step.
const packagesDir = resolve(import.meta.dirname, "packages");
const alias = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@merge-safely/${d.name}`, resolve(packagesDir, d.name, "src/index.ts")]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: { provider: "v8", include: ["packages/*/src/**"] },
  },
});
