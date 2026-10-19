import { DEFAULT_POLICY } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { hardenForFork, type LoadPolicyOptions, loadActionPolicy } from "../src/policy.js";

const repo = { host: "github.com", owner: "acme", name: "app" };

function opts(over: Partial<LoadPolicyOptions> & { remote?: Record<string, string>; local?: Record<string, string> }) {
  const reads: string[] = [];
  const logs: string[] = [];
  const o: LoadPolicyOptions = {
    repo,
    baseRef: "main",
    path: ".merge-safely.yml",
    explicit: false,
    fork: false,
    workspace: "/work/app",
    sources: {
      getFile: async (_r, path, ref) => {
        reads.push(`api:${ref}:${path}`);
        return over.remote?.[`${ref}:${path}`] ?? null;
      },
      readLocal: async (p) => {
        reads.push(`local:${p}`);
        return over.local?.[p] ?? null;
      },
    },
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
    ...over,
  };
  return { o, reads, logs };
}

describe("loadActionPolicy", () => {
  it("reads the policy from the base branch via the API, never the checkout", async () => {
    const { o, reads } = opts({
      remote: { "main:.merge-safely.yml": "budget: { perChangeUsd: 9 }\n" },
      local: { "/work/app/.merge-safely.yml": "budget: { perChangeUsd: 999 }\n" },
    });
    const p = await loadActionPolicy(o);
    expect(p.policy.budget.perChangeUsd).toBe(9);
    expect(p.source).toBe("acme/app@main:.merge-safely.yml");
    expect(reads).toEqual(["api:main:.merge-safely.yml"]);
  });

  it("missing policy -> defaults", async () => {
    const { o, logs } = opts({});
    const p = await loadActionPolicy(o);
    expect(p.policy).toEqual(DEFAULT_POLICY);
    expect(p.source).toBe("defaults");
    expect(logs.join("\n")).toMatch(/using the defaults/);
  });

  it("invalid policy -> error listing the problems", async () => {
    const { o } = opts({ remote: { "main:.merge-safely.yml": "quorum: { t1: -4 }\nnope: true\n" } });
    await expect(loadActionPolicy(o)).rejects.toThrow(/acme\/app@main:.merge-safely.yml is invalid: .*/);
  });

  it("invalid YAML -> error with the line, not the text", async () => {
    const { o } = opts({ remote: { "main:.merge-safely.yml": "a: [\n" } });
    await expect(loadActionPolicy(o)).rejects.toThrow(/is not valid YAML/);
  });

  it("an explicit path in the checkout is honoured for same-repo PRs", async () => {
    const { o } = opts({
      explicit: true,
      path: "config/ms.yml",
      local: { "/work/app/config/ms.yml": "budget: { perChangeUsd: 3 }\n" },
    });
    const p = await loadActionPolicy(o);
    expect(p.policy.budget.perChangeUsd).toBe(3);
    expect(p.source).toBe("checkout:config/ms.yml");
  });

  it("an explicit path not in the checkout is read from the base branch", async () => {
    const { o, reads } = opts({
      explicit: true,
      path: "config/ms.yml",
      remote: { "main:config/ms.yml": "budget: { perChangeUsd: 4 }\n" },
    });
    expect((await loadActionPolicy(o)).policy.budget.perChangeUsd).toBe(4);
    expect(reads).toEqual(["local:/work/app/config/ms.yml", "api:main:config/ms.yml"]);
  });

  it("on a fork PR the checkout is ignored and the base branch wins", async () => {
    const { o, logs } = opts({
      explicit: true,
      fork: true,
      path: "config/ms.yml",
      local: { "/work/app/config/ms.yml": "runner: { allowedCommands: ['npm test'] }\n" },
      remote: { "main:config/ms.yml": "budget: { perChangeUsd: 5 }\n" },
    });
    const p = await loadActionPolicy(o);
    expect(p.policy.budget.perChangeUsd).toBe(5);
    expect(p.policy.runner.allowedCommands).toEqual([]);
    expect(logs.join("\n")).toMatch(/warn:ignoring config\/ms.yml in the runner checkout: this PR is from a fork/);
  });
});

describe("hardenForFork", () => {
  const withCommands = {
    policy: { ...DEFAULT_POLICY, runner: { ...DEFAULT_POLICY.runner, allowedCommands: ["npm test"] } },
    hash: "h",
    source: "acme/app@main:.merge-safely.yml",
  };

  it("empties allowedCommands on a fork PR, warns, and re-hashes", () => {
    const warnings: string[] = [];
    const p = hardenForFork(withCommands, true, (m) => warnings.push(m));
    expect(p.policy.runner.allowedCommands).toEqual([]);
    expect(p.hash).not.toBe("h");
    expect(p.source).toMatch(/allowedCommands disabled: fork PR/);
    expect(warnings[0]).toMatch(/^SECURITY: runner.allowedCommands is set/);
  });

  it("leaves same-repo PRs and command-free policies alone", () => {
    const warn = () => {
      throw new Error("no warning expected");
    };
    expect(hardenForFork(withCommands, false, warn)).toBe(withCommands);
    const plain = { policy: DEFAULT_POLICY, hash: "x", source: "defaults" };
    expect(hardenForFork(plain, true, warn)).toBe(plain);
  });
});
