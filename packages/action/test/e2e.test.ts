import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGithubServer, type FakeModelServer, fakeGithubServer, fakeModelServer } from "./fake-servers.js";
import { fixture } from "./helpers.js";

const BUNDLE = join(import.meta.dirname, "..", "dist", "index.js");
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const KEY = "sk-local-e2e-secret-0123456789";

function runNode(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("bundled action end to end (fake GitHub + fake model endpoint, no network)", () => {
  let gh: FakeGithubServer | undefined;
  let models: FakeModelServer | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await gh?.close();
    await models?.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a docs-only PR is triaged to a pass: success check run, outputs and summary, no model completions", async () => {
    gh = await fakeGithubServer({
      owner: "acme",
      repo: "app",
      number: 7,
      headSha: HEAD,
      baseSha: BASE,
      files: [
        {
          filename: "docs/setup.md",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1,2 +1,3 @@\n # Setup\n-Old\n+New\n+More",
        },
      ],
    });
    models = await fakeModelServer();
    const dir = mkdtempSync(join(tmpdir(), "ms-e2e-"));
    dirs.push(dir);
    const event = fixture("pull_request.synchronize");
    const pr = event.pull_request as { head: { sha: string }; base: { sha: string } };
    pr.head.sha = HEAD;
    pr.base.sha = BASE;
    writeFileSync(join(dir, "event.json"), JSON.stringify(event));
    writeFileSync(join(dir, "output"), "");
    writeFileSync(join(dir, "summary"), "");

    const r = await runNode({
      PATH: process.env.PATH ?? "",
      HOME: dir,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_API_URL: gh.url,
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      RUNNER_TEMP: dir,
      INPUT_CONNECTIONS: `local: { provider: openai-compatible, baseUrl: "${models.url}/v1", apiKey: "${KEY}" }`,
      "INPUT_GITHUB-TOKEN": "ghs_e2eworkflowtoken0000000000",
      "INPUT_FAIL-ON-BLOCK": "true",
      INPUT_POLICY: ".merge-safely.yml",
      INPUT_CONCURRENCY: "2",
    });

    const output = readFileSync(join(dir, "output"), "utf8");
    const summary = readFileSync(join(dir, "summary"), "utf8");
    expect({ code: r.code, stderr: r.stderr, unhandled: gh.unhandled }).toEqual({ code: 0, stderr: "", unhandled: [] });
    const printed = r.stdout
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    expect(`${printed}${output}${summary}`).not.toContain(KEY);
    expect(r.stdout).toContain(`::add-mask::${KEY}`);

    // The verdict check run on the head SHA, completed green, with the stored verdict.
    const run = gh.checkRuns.find((c) => c.name === "merge-safely/verdict" && c.head_sha === HEAD);
    expect(run).toMatchObject({ status: "completed", conclusion: "success" });
    expect(String((run?.output as { text?: string } | undefined)?.text)).toContain("merge-safely:verdict");
    const started = gh.requests.find((q) => q.method === "POST" && q.path === "/repos/acme/app/check-runs");
    expect(JSON.stringify(started?.body)).toContain("action:pull_request");
    expect(gh.requests.some((q) => q.path === "/repos/acme/app/contents/.merge-safely.yml")).toBe(true);

    expect(output).toMatch(/decision<<\S+\npass\n/);
    expect(output).toMatch(/tier<<\S+\n0\n/);
    expect(output).toMatch(new RegExp(`check-url<<\\S+\\nhttps://github.com/acme/app/runs/${run?.id}\\n`));
    expect(summary).toMatch(/PASS/);
    expect(String((run?.output as { text?: string } | undefined)?.text)).toContain("merge-safely-action@0.1.0");

    // Key validated against the models endpoint; triage meant no completion calls.
    expect(models.requests.some((q) => q.path.endsWith("/models"))).toBe(true);
    expect(models.requests.filter((q) => !q.path.endsWith("/models"))).toEqual([]);
  }, 60_000);
});
