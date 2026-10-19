import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";

const BUNDLE = join(import.meta.dirname, "..", "dist", "index.js");

/** Run the committed bundle the way GitHub does: `node dist/index.js`, inputs as INPUT_* variables. */
function runBundle(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ms-action-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(fixture("pull_request.synchronize")));
  return spawnSync(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      RUNNER_TEMP: dir,
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("dist/index.js", () => {
  it("exists (it is committed; run `npm run bundle -w @merge-safely/action`)", () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  it("fails cleanly without inputs: one error annotation, no stack trace", () => {
    const r = runBundle({});
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^::error::error \[INPUT\]: connections input is required/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at |%0A\s+at /);
    expect(r.stderr).toBe("");
  });

  it("refuses a fork pull_request before touching the network", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-action-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(fixture("pull_request.opened.fork")));
    const r = runBundle({ GITHUB_EVENT_PATH: eventPath, INPUT_CONNECTIONS: "a: { provider: anthropic, apiKey: x }" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/::error::error \[FORK_PULL_REQUEST\]/);
  });
});
