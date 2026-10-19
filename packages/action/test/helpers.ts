import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliGate, CliReviewResult, GateFactory, GateSetup } from "@merge-safely/cli";
import type { HumanDigest, Tier, Verdict, VerdictStore } from "@merge-safely/core";
import type { CheckRunCreateParams, CheckRunData, OctokitLike, PullRequestData } from "@merge-safely/github";
import type { ActionCore, ActionGithub, RunDeps } from "../src/run.js";

export const HEAD = "1".repeat(40);
export const BASE = "2".repeat(40);
export const QUEUE = "3".repeat(40);
export const FIXTURES = join(import.meta.dirname, "fixtures");

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

export const tier = (level: Tier["level"]): Tier => ({
  level,
  score: level * 25,
  factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] },
  reasons: [],
});

export function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    repo: { host: "github.com", owner: "acme", name: "app" },
    number: 7,
    headSha: HEAD,
    kind: "machine",
    decision: "pass",
    tier: tier(2),
    round: 1,
    triaged: false,
    seats: [],
    findings: [],
    quorum: { required: 2, passed: 2, blocked: 0, invalid: 0 },
    cost: { usd: 0.4321, tokens: { in: 1200, out: 300 }, bySeat: {} },
    createdAt: "2026-10-19T00:00:00.000Z",
    policyHash: "deadbeef",
    ...over,
  };
}

export const digest = (headline: string, markdown = `## ${headline}`): HumanDigest => ({
  headline,
  markdown,
  text: headline,
});

export function result(outcome: CliReviewResult["outcome"], over: Partial<CliReviewResult> = {}): CliReviewResult {
  const decision = outcome === "block" ? "block" : outcome === "pass" ? "pass" : "pending";
  return {
    outcome,
    digest: digest(`Verdict: ${outcome.toUpperCase()}`),
    verdict: verdict({ decision, ...(outcome === "contested" ? { contested: true } : {}) }),
    ...over,
  };
}

export interface FakeCore extends ActionCore {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  failed: string[];
  secrets: string[];
  logs: Array<{ level: string; msg: string }>;
  summaries: string[];
  all(): string;
}

export function fakeCore(inputs: Record<string, string> = {}): FakeCore {
  const c: FakeCore = {
    inputs: {
      policy: ".merge-safely.yml",
      "github-token": "ghs_workflowtoken000000000000",
      "fail-on-block": "true",
      ...inputs,
    },
    outputs: {},
    failed: [],
    secrets: [],
    logs: [],
    summaries: [],
    getInput: (n) => (c.inputs[n] ?? "").trim(),
    setOutput: (n, v) => {
      c.outputs[n] = v;
    },
    setFailed: (m) => {
      c.failed.push(m);
    },
    setSecret: (s) => {
      c.secrets.push(s);
    },
    debug: (msg) => c.logs.push({ level: "debug", msg }),
    info: (msg) => c.logs.push({ level: "info", msg }),
    notice: (msg) => c.logs.push({ level: "notice", msg }),
    warning: (msg) => c.logs.push({ level: "warning", msg }),
    error: (msg) => c.logs.push({ level: "error", msg }),
    async writeSummary(md) {
      c.summaries.push(md);
    },
    all: () => [...c.failed, ...c.logs.map((l) => l.msg), ...c.summaries, ...Object.values(c.outputs)].join("\n"),
  };
  return c;
}

export interface FakeGithub extends ActionGithub {
  pull: PullRequestData;
  files: Record<string, string>;
  fileReads: string[];
  checkRuns: CheckRunData[];
  created: CheckRunCreateParams[];
  pullsByNumber: Record<number, string>;
}

export function pullData(over: { headRepo?: string | null; headSha?: string; baseRef?: string; draft?: boolean } = {}) {
  const headRepo = over.headRepo === undefined ? "acme/app" : over.headRepo;
  return {
    number: 7,
    title: "Add retry",
    body: "",
    html_url: "https://github.com/acme/app/pull/7",
    draft: over.draft ?? false,
    user: { login: "dev", id: 12 },
    labels: [],
    head: { sha: over.headSha ?? HEAD, ref: "feature", repo: headRepo === null ? null : { full_name: headRepo } },
    base: { sha: BASE, ref: over.baseRef ?? "main", repo: { full_name: "acme/app" } },
    additions: 10,
    deletions: 2,
    changed_files: 1,
  } satisfies PullRequestData;
}

export function fakeGithub(pull: PullRequestData = pullData()): FakeGithub {
  const g: FakeGithub = {
    pull,
    files: {},
    fileReads: [],
    checkRuns: [],
    created: [],
    pullsByNumber: {},
    async getFile(_repo, path, ref) {
      g.fileReads.push(`${ref}:${path}`);
      return g.files[`${ref}:${path}`] ?? null;
    },
    octokit: {
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => {
          const sha = g.pullsByNumber[pull_number];
          const data = sha ? { ...g.pull, number: pull_number, head: { ...g.pull.head, sha } } : g.pull;
          return { data };
        },
      },
      checks: {
        listForRef: async ({ ref }: { ref: string }) => {
          const runs = g.checkRuns.filter((r) => r.head_sha === ref);
          return { data: { total_count: runs.length, check_runs: runs } };
        },
        create: async (p: CheckRunCreateParams) => {
          g.created.push(p);
          return { data: { id: 4242, name: p.name, head_sha: p.head_sha } };
        },
      },
      apps: {
        getAuthenticated: async () => {
          throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
        },
      },
    } as unknown as OctokitLike,
  };
  return g;
}

export class FakeGate implements CliGate {
  reviewResult: CliReviewResult = result("pass");
  calls: Array<{ ref: unknown; opts: unknown }> = [];
  async review(ref: Parameters<CliGate["review"]>[0], opts: { headSha?: string }) {
    this.calls.push({ ref, opts });
    return this.reviewResult;
  }
  async reviewChange(): Promise<CliReviewResult> {
    throw new Error("not used");
  }
  async estimate(): ReturnType<CliGate["estimate"]> {
    throw new Error("not used");
  }
  async explain() {
    return null;
  }
  async recordHumanVerdict(): Promise<Verdict> {
    throw new Error("not used");
  }
}

export function fakeGateFactory(gate = new FakeGate()): GateFactory & { setups: GateSetup[]; gate: FakeGate } {
  const setups: GateSetup[] = [];
  const f = async (s: GateSetup) => {
    setups.push(s);
    return gate;
  };
  return Object.assign(f, { setups, gate });
}

export function memoryStore(verdicts: Verdict[]): VerdictStore {
  return {
    async get(key) {
      const v = verdicts.filter((x) => x.number === key.number && x.headSha === key.headSha).at(-1);
      return v ? { verdict: v, version: "1" } : null;
    },
    async put() {
      return { ok: true, version: "1" };
    },
    async listForChange(_repo, number) {
      return verdicts.filter((v) => v.number === number);
    },
  };
}

export interface Harness {
  core: FakeCore;
  gh: FakeGithub;
  factory: ReturnType<typeof fakeGateFactory>;
  deps: RunDeps;
  files: Record<string, string>;
}

/** A run with event `name` and payload fixture (or object). */
export function harness(
  name: string,
  payload: Record<string, unknown> | string,
  inputs: Record<string, string> = {},
  opts: { env?: NodeJS.ProcessEnv; pull?: PullRequestData; store?: VerdictStore } = {},
): Harness {
  const core = fakeCore({
    connections: 'anthropic-main: { provider: anthropic, apiKey: "sk-ant-api03-supersecretvalue1234" }',
    ...inputs,
  });
  const gh = fakeGithub(opts.pull);
  const factory = fakeGateFactory();
  const files: Record<string, string> = {
    "/events/event.json": JSON.stringify(typeof payload === "string" ? fixture(payload) : payload),
  };
  const deps: RunDeps = {
    core,
    env: {
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: "/events/event.json",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "99",
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: "/runner/tmp",
      GITHUB_WORKSPACE: "/work/app",
      ...opts.env,
    },
    readFile: async (p) => files[p] ?? null,
    github: () => gh,
    gateFactory: factory,
    ...(opts.store ? { verdictStore: () => opts.store as VerdictStore } : {}),
    now: () => new Date("2026-10-19T12:00:00.000Z"),
  };
  return { core, gh, factory, deps, files };
}
