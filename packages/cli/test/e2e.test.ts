/**
 * End to end through the REAL gate (createGate from @merge-safely/core) with testkit's scripted fake provider:
 * `run --local` and `estimate --local` on a temp git repo. No network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderRegistry } from "@merge-safely/providers";
import { fakeProvider, type Script, scenarios, scriptedRuns } from "@merge-safely/testkit";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/exec.js";
import { realGateFactory } from "../src/gate.js";
import { harness, tempDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function repo(): string {
  const dir = tempDir("ms-e2e-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Ada");
  git(dir, "config", "user.email", "ada@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  return dir;
}

function codeChange(dir: string): void {
  const lines = Array.from({ length: 45 }, (_, i) => `export const v${i} = (x: number) => x * ${i} + 1;`);
  writeFileSync(join(dir, "src/math.ts"), `${lines.join("\n")}\n`);
}

function setup(dir: string, script?: Script) {
  const provider = fakeProvider({ id: "fake", ...(script ? { script } : {}) });
  const h = harness({ cwd: dir, exec: execCommand });
  writeFileSync(
    join(h.home, "connections.json"),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: "fake-main",
          provider: "fake",
          kind: "api-key",
          secret: { kind: "api-key", apiKey: "fake-key-0123456789" },
        },
      ],
    }),
    { mode: 0o600 },
  );
  h.ctx.gateFactory = realGateFactory(() => createProviderRegistry([provider]));
  return { h, provider };
}

describe("run --local through the real gate", () => {
  it("auto-passes a docs-only change with no model call (exit 0)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "# demo\n\nMore words.\n");
    const { h, provider } = setup(dir);
    const r = await h.run("run", "--local", "--base", "main");
    expect(r.stderr).not.toContain("error [");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
    expect(provider.calls).toHaveLength(0);
  });

  it("blocks when a hunter raises a confirmed blocker (exit 1)", async () => {
    const dir = repo();
    codeChange(dir);
    const { h, provider } = setup(dir, scenarios.oneBlocker("correctness"));
    const r = await h.run("run", "--local", "--base", "main", "--concurrency", "1");
    expect(r.stderr).not.toContain("error [");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/BLOCK/);
    expect(r.stdout).toContain("correctness: change breaks an invariant");
    expect(r.stdout).not.toContain("WORKTRE");
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it("passes when every seat passes (exit 0) and reports JSON", async () => {
    const dir = repo();
    codeChange(dir);
    const { h } = setup(dir, scenarios.allPass());
    const r = await h.run("--json", "run", "--local", "--base", "main");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { outcome: string; verdict: { headSha: string; decision: string } };
    expect(out.outcome).toBe("pass");
    expect(out.verdict.headSha).toBe("WORKTREE");
  });

  it("is pending when the provider is down (exit 2)", async () => {
    const dir = repo();
    codeChange(dir);
    const { h } = setup(dir, scriptedRuns({ hunters: { "*": "error" }, judges: { "*": "error" } }));
    const r = await h.run("run", "--local", "--base", "main");
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/PENDING/);
  });

  it("estimate --local prints the panel and cost without calling a model", async () => {
    const dir = repo();
    codeChange(dir);
    const { h, provider } = setup(dir);
    const r = await h.run("estimate", "--local", "--base", "main");
    expect(r.stderr).not.toContain("error [");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Tier \d/m);
    expect(r.stdout).toContain("fake-main");
    expect(r.stdout).toContain("fake-model");
    expect(r.stdout).toMatch(/Estimated cost: \$\d/);
    expect(r.stdout).toContain("Admission: would run");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("run --repo through the real gate with a fake GitHub", () => {
  it("moves the check run from pending to a verdict, stores it in the check run, and explain reads it back", async () => {
    const { fakeOctokit } = await import("./fake-octokit.js");
    const { fakeWorkspace } = await import("@merge-safely/testkit");
    const headSha = "1".repeat(40);
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = (x: number) => x * ${i} + 1;`);
    const patch = `@@ -1,1 +1,45 @@\n-export const add = (a: number, b: number) => a + b;\n${body.map((l) => `+${l}`).join("\n")}`;
    const gh = fakeOctokit({
      headSha,
      baseSha: "2".repeat(40),
      files: [{ filename: "src/math.ts", status: "modified", additions: 45, deletions: 1, patch }],
    });
    const provider = fakeProvider({ id: "fake", script: scenarios.oneBlocker("correctness") });
    const h = harness({ env: { GITHUB_TOKEN: "ghs_installation0123456789abcdef" } });
    h.github.pull = { headSha, baseRef: "main", baseSha: "2".repeat(40) };
    writeFileSync(
      join(h.home, "connections.json"),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: "fake-main",
            provider: "fake",
            kind: "api-key",
            secret: { kind: "api-key", apiKey: "fake-key-0123456789" },
          },
        ],
      }),
      { mode: 0o600 },
    );
    h.ctx.gateFactory = realGateFactory(() => createProviderRegistry([provider]), {
      octokit: () => gh.octokit,
      workspace: () => fakeWorkspace({ files: { "src/math.ts": `${body.join("\n")}\n` } }),
    });

    const r = await h.run("run", "--repo", "acme/app", "--pr", "7", "--store", "checkrun");
    expect(r.stderr).not.toContain("error [");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/BLOCK/);
    expect(gh.state.checkRuns).toHaveLength(1);
    const run = gh.state.checkRuns[0];
    expect(gh.state.checkStatusLog[0]).toBe("in_progress");
    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("failure");
    expect(run?.output.text).toContain("merge-safely:verdict");
    expect(gh.state.reviews.length).toBeGreaterThan(0);

    const e = await h.run("explain", "--repo", "acme/app", "--pr", "7", "--store", "checkrun");
    expect(e.code).toBe(1);
    expect(e.stdout).toMatch(/BLOCK/);
  });
});
