import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_VERSION } from "../src/version.js";

describe("ACTION_VERSION", () => {
  it("matches packages/action/package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(ACTION_VERSION).toBe(pkg.version);
  });
});
