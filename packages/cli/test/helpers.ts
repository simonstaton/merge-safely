import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  Connection,
  HumanDigest,
  ModelInfo,
  ModelProvider,
  ReviewerRun,
  Tier,
  ValidationResult,
  Verdict,
} from "@merge-safely/core";
import { createProviderRegistry } from "@merge-safely/providers";
import { runCli } from "../src/cli.js";
import type { Exec, ExecResult } from "../src/exec.js";
import type {
  CliEstimate,
  CliGate,
  CliReviewResult,
  GateSetup,
  HumanVerdictInput,
  LocalReviewInput,
} from "../src/gate-types.js";
import type { GithubApi } from "../src/github-api.js";
import type { Prompter } from "../src/prompt.js";
import type { CliContext } from "../src/runtime.js";

export function tempDir(prefix = "ms-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Captured {
  stdout: string;
  stderr: string;
}

export const model = (name: string, tier: ModelInfo["tier"], provider = "anthropic"): ModelInfo => ({
  provider,
  name,
  tier,
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 200_000,
  maxOutputTokens: 32_000,
  pricing: { inPerMTok: tier === "frontier" ? 5 : tier === "mid" ? 3 : 1, outPerMTok: tier === "frontier" ? 25 : 15 },
});

export interface FakeProviderOptions {
  id?: string;
  kinds?: Connection["kind"][];
  validate?: (conn: Connection) => ValidationResult;
  models?: ModelInfo[];
}

export function fakeProvider(opts: FakeProviderOptions = {}): ModelProvider & { validated: Connection[] } {
  const validated: Connection[] = [];
  const models = opts.models ?? [model("claude-opus-5-5", "frontier"), model("claude-sonnet-5-5", "mid")];
  return {
    id: opts.id ?? "anthropic",
    connectionKinds: opts.kinds ?? ["api-key", "oauth", "subscription", "anthropic-compatible"],
    validated,
    async validate(conn) {
      validated.push(conn);
      return opts.validate ? opts.validate(conn) : { ok: true, models, latencyMs: 12 };
    },
    async models() {
      return models;
    },
    createRunner() {
      throw new Error("fake provider does not run");
    },
  };
}

export const tier = (level: Tier["level"]): Tier => ({
  level,
  score: level * 25,
  factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] },
  reasons: [`tier ${level} for test`],
});

export function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    repo: { host: "github.com", owner: "acme", name: "app" },
    number: 7,
    headSha: "a".repeat(40),
    kind: "machine",
    decision: "pass",
    tier: tier(1),
    round: 1,
    triaged: false,
    seats: [] as ReviewerRun[],
    findings: [],
    quorum: { required: 1, passed: 1, blocked: 0, invalid: 0 },
    cost: { usd: 0.42, tokens: { in: 1, out: 1 }, bySeat: {} },
    createdAt: "2026-10-19T00:00:00.000Z",
    policyHash: "deadbeef",
    ...over,
  };
}

export const digest = (headline: string): HumanDigest => ({
  headline,
  markdown: `## ${headline}`,
  text: `${headline}\nbody`,
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

export const sampleEstimate: CliEstimate = {
  tier: tier(2),
  seats: [
    {
      id: "hunter:correctness:1",
      role: "hunter",
      lens: "correctness",
      connectionId: "anthropic-main",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      usd: 0.61,
    },
    {
      id: "judge:1",
      role: "judge",
      lens: "judge",
      connectionId: "anthropic-main",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usd: 0.45,
    },
  ],
  usd: 1.06,
  unknownSeats: [],
  ceilings: [{ ceiling: "per-change", limitUsd: 25, currentUsd: 0, projectedUsd: 1.06, breached: false }],
  admitted: true,
  downgrades: [],
  warnings: [],
};

/** A scriptable fake gate that records how it was built and called. */
export class FakeGate implements CliGate {
  setups: GateSetup[] = [];
  calls: Array<{ method: string; arg: unknown }> = [];
  reviewResult: CliReviewResult = result("pass");
  estimateResult: CliEstimate = sampleEstimate;
  explainResult: { verdict: Verdict; digest: HumanDigest } | null = null;
  error: unknown;

  factory = async (setup: GateSetup): Promise<CliGate> => {
    this.setups.push(setup);
    return this;
  };

  private hit(method: string, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.error) throw this.error;
  }
  async review(ref: unknown, opts: unknown): Promise<CliReviewResult> {
    this.hit("review", { ref, opts });
    return this.reviewResult;
  }
  async reviewChange(input: LocalReviewInput): Promise<CliReviewResult> {
    this.hit("reviewChange", input);
    return this.reviewResult;
  }
  async estimate(target: unknown): Promise<CliEstimate> {
    this.hit("estimate", target);
    return this.estimateResult;
  }
  async explain(ref: unknown) {
    this.hit("explain", ref);
    return this.explainResult;
  }
  async recordHumanVerdict(input: HumanVerdictInput): Promise<Verdict> {
    this.hit("recordHumanVerdict", input);
    return verdict({
      kind: "human",
      decision: input.decision,
      headSha: input.headSha,
      signedBy: input.signedBy,
      reason: input.reason,
    });
  }
}

export class FakeGithub implements GithubApi {
  fileRefs: string[] = [];
  files: Record<string, string> = {};
  pull = { headSha: "b".repeat(40), baseRef: "main", baseSha: "c".repeat(40) };
  async getPull() {
    return this.pull;
  }
  async getFile(_repo: unknown, path: string, ref: string) {
    this.fileRefs.push(ref);
    return this.files[`${ref}:${path}`] ?? null;
  }
}

export type ExecScript = (cmd: string, args: string[]) => ExecResult | undefined;

export interface Harness {
  ctx: CliContext;
  gate: FakeGate;
  github: FakeGithub;
  provider: ReturnType<typeof fakeProvider>;
  home: string;
  run(...argv: string[]): Promise<Captured & { code: number }>;
}

export function scriptedPrompter(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    return answers.shift() ?? "";
  };
  return { asked, ask: next, secret: next };
}

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  exec?: Exec;
  provider?: ReturnType<typeof fakeProvider>;
  extraProviders?: ModelProvider[];
  prompter?: Prompter;
  stdinIsTTY?: boolean;
}

const noGh: Exec = async () => ({ code: -1, stdout: "", stderr: "" });

export function harness(opts: HarnessOptions = {}): Harness {
  const home = tempDir("ms-home-");
  const gate = new FakeGate();
  const github = new FakeGithub();
  const provider = opts.provider ?? fakeProvider();
  let out = "";
  let err = "";
  const ctx: CliContext = {
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: new PassThrough(),
      stdinIsTTY: opts.stdinIsTTY ?? false,
      stdoutIsTTY: false,
    },
    env: { MERGE_SAFELY_HOME: home, ...opts.env },
    cwd: opts.cwd ?? home,
    exec: opts.exec ?? noGh,
    gateFactory: gate.factory,
    registry: () => createProviderRegistry([provider, ...(opts.extraProviders ?? [])]),
    github: () => github,
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    ...(opts.prompter ? { prompter: opts.prompter } : {}),
  };
  return {
    ctx,
    gate,
    github,
    provider,
    home,
    async run(...argv) {
      out = "";
      err = "";
      const code = await runCli(argv, ctx);
      return { code, stdout: out, stderr: err };
    },
  };
}
