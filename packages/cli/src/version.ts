import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch (_err: unknown) {
    // fall through
  }
  return "0.0.0";
}

export const CLI_VERSION = readVersion();
