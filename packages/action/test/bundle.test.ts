import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";

const DIST = join(import.meta.dirname, "..", "dist");
const BUNDLE = join(DIST, "index.js");
const WRAPPER = join(DIST, "git-wrapper.js");
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ms-action-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Run the committed bundle the way GitHub does: `node dist/index.js`, inputs as INPUT_* variables. */
function runBundle(env: Record<string, string>, event = "pull_request.synchronize") {
  const dir = tempDir();
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(fixture(event)));
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
    const r = runBundle({ INPUT_CONNECTIONS: "a: { provider: anthropic, apiKey: x }" }, "pull_request.opened.fork");
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/::error::error \[FORK_PULL_REQUEST\]/);
  });

  it("a YAML tag in connections never prints the key (no YAMLWarning on stderr)", () => {
    const key = "sk-ant-SECRETVALUE1234567890";
    const r = runBundle({
      INPUT_CONNECTIONS: `anthropic-main: { provider: anthropic, apiKey: !foo "${key}" }`,
      "INPUT_GITHUB-TOKEN": "ghs_x0000000000000000000000",
      GITHUB_API_URL: "http://127.0.0.1:9", // unreachable: the run must fail before any call matters
    });
    expect(r.stderr).not.toContain(key);
    expect(r.stderr).not.toMatch(/YAMLWarning/);
    const printed = r.stdout
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    expect(printed).not.toContain(key);
  });
});

describe("dist/git-wrapper.js (runner: cli)", () => {
  it("is where the bundled CLI runner resolves it: next to index.js", () => {
    expect(readFileSync(BUNDLE, "utf8")).toContain('new URL("./git-wrapper.js", import_meta_url)');
    expect(existsSync(WRAPPER)).toBe(true);
  });

  it("runs and enforces the git guard", () => {
    const noCwd = spawnSync(process.execPath, [WRAPPER, "log"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(noCwd.status).toBe(2);
    expect(noCwd.stderr).toContain("ms-git: MS_GIT_CWD is not set");
    const denied = spawnSync(process.execPath, [WRAPPER, "push", "origin"], {
      env: { PATH: process.env.PATH ?? "", MS_GIT_CWD: tempDir() },
      encoding: "utf8",
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/ms-git/);
  });
});
