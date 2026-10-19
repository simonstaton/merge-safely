import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GIT_SAFE_CONFIG, GitGuardError, gitResolver, planGit, runGitWrapper } from "./git-guard.js";

let repo: string;
let head: string;
let first: string;
const g = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ms-git-guard-"));
  g("init", "-q");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "first");
  first = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.ts"), "one\ntwo\n");
  g("commit", "-qam", "second");
  head = g("rev-parse", "HEAD");
});

const plan = (...argv: string[]) => planGit(argv, repo, gitResolver(repo));
const tail = (args: string[]) => args.slice(GIT_SAFE_CONFIG.length);

describe("planGit: allowed forms", () => {
  it("resolves revisions and ranges to SHAs and puts paths after --", () => {
    expect(tail(plan("diff", "HEAD~1", "HEAD", "--", "src/a.ts"))).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      first,
      head,
      "--",
      "src/a.ts",
    ]);
    expect(tail(plan("diff", "HEAD~1..HEAD", "--stat"))).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      `${first}..${head}`,
      "--",
    ]);
    expect(tail(plan("log", "--oneline", "-n5", "src"))).toEqual([
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--oneline",
      "-n5",
      "--",
      "src",
    ]);
    expect(tail(plan("blame", "-L1,2", "src/a.ts"))).toEqual(["blame", "--no-textconv", "-L1,2", "--", "src/a.ts"]);
    expect(tail(plan("show", "HEAD:src/a.ts"))).toEqual([
      "show",
      "--no-ext-diff",
      "--no-textconv",
      `${head}:src/a.ts`,
      "--",
    ]);
    expect(tail(plan("log", "--format=%h %an %s", "--max-count=3"))).toContain("--format=%h %an %s");
    expect(tail(plan("log", "-L1,1:src/a.ts"))).toContain("-L1,1:src/a.ts");
    expect(plan("diff").slice(0, GIT_SAFE_CONFIG.length)).toEqual(GIT_SAFE_CONFIG);
    expect(GIT_SAFE_CONFIG).toEqual(
      expect.arrayContaining(["core.hooksPath=/dev/null", "diff.external=", "core.pager=cat"]),
    );
  });
});

describe("planGit: rejected forms", () => {
  const rejected: [string, string[]][] = [
    ["subcommand", ["status"]],
    ["subcommand", ["config", "core.pager", "sh"]],
    ["--output", ["log", "-1", "--format=x", "--output=/tmp/pwned"]],
    ["--output (split)", ["diff", "--output", "/tmp/pwned"]],
    ["--no-index", ["diff", "--no-index", "/etc/passwd", "/dev/null"]],
    ["--ext-diff", ["diff", "--ext-diff"]],
    ["--textconv", ["log", "-p", "--textconv"]],
    ["-O", ["diff", "-O/etc/passwd"]],
    ["unlisted option", ["log", "--all"]],
    ["unlisted option", ["log", "--exec=sh"]],
    ["format placeholder", ["log", "--format=%(trailers)"]],
    ["format placeholder", ["log", "--pretty=format:%C(red)%h"]],
    ["reflog syntax", ["log", "HEAD@{1}"]],
    ["search syntax", ["show", ":/second"]],
    ["search syntax", ["show", "HEAD^{/first}"]],
    ["unknown revision", ["diff", "nope-not-a-ref"]],
    ["path escape", ["diff", "HEAD", "--", "../outside"]],
    ["absolute path", ["log", "--", "/etc/passwd"]],
    ["path escape in -L", ["log", "-L1,2:../x"]],
    ["log -L without file", ["log", "-L1,2"]],
    ["blob path escape", ["show", "HEAD:../x"]],
    ["-n with space", ["log", "-n", "5"]],
  ];

  for (const [why, argv] of rejected) {
    it(`rejects ${why}: ms-git ${argv.join(" ")}`, () => {
      expect(() => plan(...argv)).toThrow(GitGuardError);
    });
  }

  it("names the forbidden option in the error", () => {
    expect(() => plan("log", "-1", "--output=/tmp/x")).toThrow(/--output/);
    expect(() => plan("diff", "--no-index", "a", "b")).toThrow(/--no-index/);
  });

  it("treats a dash path after -- literally, never as an option", () => {
    expect(tail(plan("log", "--", "--output=x"))).toEqual([
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      "--output=x",
    ]);
  });
});

describe("runGitWrapper", () => {
  it("runs git in the workspace and refuses forbidden calls without side effects", () => {
    const errs: string[] = [];
    expect(runGitWrapper(["log", "--oneline", "-n1"], repo, { stderr: (s) => errs.push(s) })).toBe(0);
    const out = join(repo, "pwned.txt");
    expect(runGitWrapper(["log", "-1", `--output=${out}`], repo, { stderr: (s) => errs.push(s) })).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(errs.join("")).toContain("--output");
  });
});
