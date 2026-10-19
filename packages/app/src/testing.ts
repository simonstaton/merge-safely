/**
 * Fakes for the App's tests (and for anyone embedding the App): an in-memory installation client, a recording gate
 * and a signed webhook request builder. No network.
 */
import { createHmac } from "node:crypto";
import type { HumanDigest, Tier, Verdict } from "@merge-safely/core";
import type { CheckRunData, PullFileData } from "@merge-safely/github";
import type { AppConfig } from "./config.js";
import type { Gate, GateDeps, GateFactory, HumanVerdictInput } from "./gate.js";
import type { AppOctokit } from "./run-job.js";

export const TEST_MASTER_KEY = "a".repeat(64);
export const TEST_WEBHOOK_SECRET = "webhook-secret-for-tests";
export const TEST_SETUP_TOKEN = "setup-token-for-tests-0123456789";
export const HEAD_SHA = "1".repeat(40);
export const BASE_SHA = "2".repeat(40);

export function testConfig(dataDir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    appId: "12345",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n",
    webhookSecret: TEST_WEBHOOK_SECRET,
    masterKey: TEST_MASTER_KEY,
    dataDir,
    dbPath: `${dataDir}/app.db`,
    port: 0,
    setupToken: TEST_SETUP_TOKEN,
    concurrency: 2,
    logLevel: "error",
    shutdownDeadlineMs: 1000,
    publicUrl: "https://gate.example.com",
    ...over,
  };
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export interface FakeOctokitOptions {
  /** `.merge-safely.yml` text per ref; missing ref => 404. */
  policies?: Record<string, string>;
  headSha?: string;
  baseRef?: string;
  token?: string;
  /** PR files (pulls.listFiles) and the unified diff compare returns. */
  files?: PullFileData[];
  diff?: string;
}

export interface Call {
  method: string;
  params: unknown;
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

export function fakeOctokit(opts: FakeOctokitOptions = {}): AppOctokit & { calls: Call[]; checkRuns: CheckRunData[] } {
  const calls: Call[] = [];
  const checkRuns: CheckRunData[] = [];
  const rec =
    <P, R>(method: string, fn: (p: P) => R) =>
    async (p: P): Promise<R> => {
      calls.push({ method, params: p });
      return fn(p);
    };
  const unused = (method: string) => async (p: unknown) => {
    calls.push({ method, params: p });
    throw new Error(`fake octokit: ${method} not implemented`);
  };
  const ok = { data: { id: 1 } };
  const octokit = {
    calls,
    checkRuns,
    pulls: {
      get: rec("pulls.get", (p: { pull_number: number }) => ({
        data: {
          number: p.pull_number,
          title: "t",
          body: "",
          html_url: "https://github.com/o/r/pull/1",
          user: { login: "dev", id: 1 },
          labels: [],
          head: { sha: opts.headSha ?? HEAD_SHA, ref: "feature", repo: { full_name: "o/r" } },
          base: { sha: BASE_SHA, ref: opts.baseRef ?? "main", repo: { full_name: "o/r" } },
          additions: (opts.files ?? []).reduce((n, f) => n + f.additions, 0) || 1,
          deletions: (opts.files ?? []).reduce((n, f) => n + f.deletions, 0),
          changed_files: (opts.files ?? []).length || 1,
        },
      })),
      listFiles: rec("pulls.listFiles", (p: { page?: number }) => ({
        data: (p.page ?? 1) === 1 ? (opts.files ?? []) : [],
      })),
      listCommits: rec("pulls.listCommits", () => ({ data: [] })),
      listReviews: rec("pulls.listReviews", () => ({ data: [] })),
      listReviewComments: rec("pulls.listReviewComments", () => ({ data: [] })),
      createReview: rec("pulls.createReview", () => ok),
      dismissReview: rec("pulls.dismissReview", () => ok),
    },
    repos: {
      getContent: async (p: { path: string; ref?: string }) => {
        calls.push({ method: "repos.getContent", params: p });
        const text = p.ref !== undefined ? opts.policies?.[p.ref] : undefined;
        if (text === undefined) throw notFound();
        return { data: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") } };
      },
      createCommitStatus: rec("repos.createCommitStatus", () => ok),
      getCombinedStatusForRef: rec("repos.getCombinedStatusForRef", () => ({ data: { statuses: [] } })),
      compareCommitsWithBasehead: rec(
        "repos.compareCommitsWithBasehead",
        (p: { mediaType?: { format?: string } }): { data: unknown } =>
          p.mediaType?.format === "diff" ? { data: opts.diff ?? "" } : { data: { files: opts.files ?? [] } },
      ),
    },
    checks: {
      listForRef: rec("checks.listForRef", () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } })),
      create: rec("checks.create", (p: { name: string; head_sha: string; conclusion?: string }) => {
        const run: CheckRunData = {
          id: checkRuns.length + 1,
          name: p.name,
          head_sha: p.head_sha,
          status: "completed",
          conclusion: p.conclusion ?? null,
          started_at: null,
          completed_at: null,
          output: { title: null, summary: null, text: null },
          app: { id: 12345 },
        };
        checkRuns.push(run);
        return { data: run };
      }),
      update: rec("checks.update", (p: { check_run_id: number }) => ({
        data: checkRuns[p.check_run_id - 1] as CheckRunData,
      })),
    },
    issues: {
      listComments: rec("issues.listComments", () => ({ data: [] })),
      createComment: rec("issues.createComment", () => ok),
      updateComment: rec("issues.updateComment", () => ok),
    },
    apps: { getAuthenticated: rec("apps.getAuthenticated", () => ({ data: { id: 12345, slug: "merge-safely" } })) },
    teams: { getMembershipForUserInOrg: unused("teams.getMembershipForUserInOrg") },
    auth: async (...args: unknown[]) => {
      calls.push({ method: "auth", params: args[0] });
      return { type: "token", token: opts.token ?? "ghs_faketokenfaketokenfaketoken0000" };
    },
  };
  return octokit as unknown as AppOctokit & { calls: Call[]; checkRuns: CheckRunData[] };
}

export const TIER: Tier = {
  level: 1,
  score: 25,
  factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] },
  reasons: [],
};

export function fakeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    repo: { host: "github.com", owner: "o", name: "r" },
    number: 7,
    headSha: HEAD_SHA,
    kind: "machine",
    decision: "pass",
    tier: TIER,
    round: 1,
    triaged: false,
    seats: [],
    findings: [],
    quorum: { required: 1, passed: 1, blocked: 0, invalid: 0 },
    cost: { tokens: { in: 0, out: 0 }, bySeat: {} },
    createdAt: "2026-10-19T00:00:00.000Z",
    policyHash: "hash",
    ...over,
  };
}

const DIGEST: HumanDigest = { headline: "pass", markdown: "pass", text: "pass" };

export interface RecordingGate {
  factory: GateFactory;
  deps: GateDeps[];
  reviews: { ref: unknown; opts: unknown }[];
  humanVerdicts: HumanVerdictInput[];
  /** Replace to change what review does (throw, delay, ...). */
  review: (n: number) => Promise<Verdict>;
}

export function recordingGate(): RecordingGate {
  const g: RecordingGate = {
    deps: [],
    reviews: [],
    humanVerdicts: [],
    review: async () => fakeVerdict(),
    factory: (deps) => {
      g.deps.push(deps);
      const gate: Gate = {
        async review(ref, opts) {
          g.reviews.push({ ref, opts });
          const verdict = await g.review(g.reviews.length);
          return { verdict, digest: DIGEST, events: [] };
        },
        async reviewChange() {
          throw new Error("recording gate: reviewChange is not used by the App");
        },
        async estimate() {
          throw new Error("recording gate: estimate is not used by the App");
        },
        async explain() {
          return { verdict: fakeVerdict(), digest: DIGEST, history: [fakeVerdict()] };
        },
        async recordHumanVerdict(input) {
          g.humanVerdicts.push(input);
          return fakeVerdict({
            kind: "human",
            decision: input.decision,
            signedBy: input.signedBy,
            reason: input.reason,
          });
        },
      };
      return gate;
    },
  };
  return g;
}
