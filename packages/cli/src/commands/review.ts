import { join } from "node:path";
import type { ChangeRef, Principal, RepoRef } from "@merge-safely/core";
import { parseRepo } from "@merge-safely/github";
import { CliError, EXIT } from "../errors.js";
import type {
  CliEstimate,
  CliGate,
  CliReviewResult,
  GateSetup,
  LocalReviewInput,
  Outcome,
  PrTarget,
  ReportKind,
  StoreKind,
} from "../gate-types.js";
import type { GithubApi } from "../github-api.js";
import { formatUsd, table } from "../io.js";
import { buildLocalChange, type LocalChange } from "../local-source.js";
import {
  defaultLoadedPolicy,
  type LoadedPolicy,
  POLICY_FILE,
  policyFromText,
  readPolicyFile,
  readPolicyOrDefault,
} from "../policy.js";
import type { Runtime } from "../runtime.js";
import { discoverGithubToken, type TokenIdentity, tokenIdentity } from "../token.js";

export function exitFor(outcome: Outcome): number {
  switch (outcome) {
    case "pass":
      return EXIT.pass;
    case "block":
      return EXIT.block;
    case "budget-blocked":
      return EXIT.budgetBlocked;
    default:
      return EXIT.pending;
  }
}

const REPORTS: readonly ReportKind[] = ["github", "status", "stdout", "json"];
const STORES: readonly StoreKind[] = ["fs", "sqlite", "checkrun"];

export interface PrOptions {
  repo?: string;
  pr?: string;
  policy?: string;
  head?: string;
}

export function parsePrNumber(v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n <= 0)
    throw new CliError("USAGE", `--pr must be a positive integer (got "${v ?? ""}")`);
  return n;
}

export function parseRepoFlag(v: string | undefined): RepoRef {
  if (!v) throw new CliError("USAGE", "--repo <owner/name> is required");
  try {
    return parseRepo(v);
  } catch (_err: unknown) {
    throw new CliError("USAGE", `--repo must look like owner/name (got "${v}")`);
  }
}

interface PrContext {
  ref: ChangeRef;
  token: string;
  identity: TokenIdentity;
  gh: GithubApi;
  headSha: string;
  baseRef: string;
  policy: LoadedPolicy;
}

/**
 * Token, PR head/base and policy for a PR command. Policy comes from `--policy`, else from `.merge-safely.yml` on the
 * PR's BASE branch (never the head), so a pull request cannot loosen its own review.
 */
async function prContext(rt: Runtime, opts: PrOptions): Promise<PrContext> {
  const repo = parseRepoFlag(opts.repo);
  const number = parsePrNumber(opts.pr);
  const found = await discoverGithubToken(rt.ctx.env, rt.ctx.exec);
  if (!found) {
    throw new CliError(
      "GITHUB_TOKEN_MISSING",
      "no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`",
    );
  }
  rt.secrets.add(found.token);
  rt.logger.debug(`GitHub token from ${found.source}`);
  const gh = rt.ctx.github(found.token);
  const pull = await gh.getPull(repo, number);
  let policy: LoadedPolicy;
  if (opts.policy) {
    policy = await readPolicyFile(opts.policy);
  } else {
    const text = await gh.getFile(repo, POLICY_FILE, pull.baseRef);
    const source = `${repo.owner}/${repo.name}@${pull.baseRef}:${POLICY_FILE}`;
    policy = text === null ? defaultLoadedPolicy() : policyFromText(text, source);
  }
  rt.logger.info(`policy: ${policy.source} (${policy.hash})`);
  return {
    ref: { repo, number },
    token: found.token,
    identity: tokenIdentity(found, rt.ctx.env),
    gh,
    headSha: opts.head ?? pull.headSha,
    baseRef: pull.baseRef,
    policy,
  };
}

export interface RunOptions extends PrOptions {
  local?: boolean;
  base?: string;
  report?: string;
  store?: string;
  slackWebhook?: string;
  dryRun?: boolean;
  concurrency?: string;
}

function prTarget(rt: Runtime, c: PrContext, opts: RunOptions): PrTarget {
  const report = (opts.report ?? (c.identity === "app" ? "github" : "status")) as ReportKind;
  if (!REPORTS.includes(report)) throw new CliError("USAGE", `--report must be one of ${REPORTS.join(", ")}`);
  const store = (opts.store ?? "fs") as StoreKind;
  if (!STORES.includes(store)) throw new CliError("USAGE", `--store must be one of ${STORES.join(", ")}`);
  if (c.identity === "user" && (report === "github" || store === "checkrun")) {
    rt.warn("check runs need a GitHub App or Actions token; with a personal token use --report status and --store fs");
  }
  return {
    mode: "pr",
    repo: c.ref.repo,
    token: c.token,
    tokenIdentity: c.identity,
    report,
    store,
    dryRun: opts.dryRun === true,
  };
}

export function parseConcurrency(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new CliError("USAGE", `--concurrency must be an integer from 1 to 32 (got "${v}")`);
  }
  return n;
}

async function makeGate(
  rt: Runtime,
  target: GateSetup["target"],
  policy: LoadedPolicy,
  extra: { slackWebhook?: string; concurrency?: string } = {},
): Promise<CliGate> {
  const concurrency = parseConcurrency(extra.concurrency);
  const connections = await rt.loadConnections({ required: true });
  const webhook = extra.slackWebhook ?? rt.ctx.env.MERGE_SAFELY_SLACK_WEBHOOK;
  if (webhook) rt.secrets.add(webhook);
  return rt.ctx.gateFactory({
    target,
    policy,
    connections,
    paths: rt.paths,
    logger: rt.logger,
    ...(webhook ? { slackWebhook: webhook } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  });
}

function printResult(rt: Runtime, result: CliReviewResult, asJson: boolean): number {
  if (asJson) {
    rt.printJson({
      outcome: result.outcome,
      exitCode: exitFor(result.outcome),
      headline: result.digest.headline,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.verdict ? { verdict: result.verdict } : {}),
    });
  } else {
    rt.out(rt.secrets.scrub(result.digest.text));
  }
  return exitFor(result.outcome);
}

async function localInput(rt: Runtime, base: string | undefined): Promise<LocalChange> {
  return buildLocalChange({ exec: rt.ctx.exec, cwd: rt.ctx.cwd, ...(base ? { base } : {}) });
}

async function localPolicy(lc: LocalChange, path: string | undefined): Promise<LoadedPolicy> {
  return path ? readPolicyFile(path) : readPolicyOrDefault(join(lc.root, POLICY_FILE));
}

export async function runCommand(rt: Runtime, opts: RunOptions): Promise<number> {
  if (opts.local) {
    if (opts.repo || opts.pr) throw new CliError("USAGE", "--local cannot be combined with --repo/--pr");
    const lc = await localInput(rt, opts.base);
    if (lc.change.files.length === 0) {
      if (rt.json) rt.printJson({ outcome: "pass", exitCode: 0, headline: "No changes against the base" });
      else rt.out(`No changes against ${lc.change.baseRef}; nothing to review.`);
      return EXIT.pass;
    }
    const policy = await localPolicy(lc, opts.policy);
    rt.logger.info(`policy: ${policy.source} (${policy.hash})`);
    if (!rt.json) {
      rt.err(
        `Reviewing ${lc.change.stats.files} files (+${lc.change.stats.additions}/-${lc.change.stats.deletions}) against ${lc.change.baseRef}${lc.dirty ? " including uncommitted changes" : ""} …`,
      );
    }
    const gate = await makeGate(rt, { mode: "local", root: lc.root }, policy, opts);
    const input: LocalReviewInput = { change: lc.change, diff: lc.diff, untrusted: lc.untrusted };
    return printResult(rt, await gate.reviewChange(input), rt.json);
  }
  const c = await prContext(rt, opts);
  const target = prTarget(rt, c, opts);
  const gate = await makeGate(rt, target, c.policy, opts);
  const result = await gate.review(c.ref, { headSha: c.headSha });
  if (target.report === "json") return printResult(rt, result, true);
  return printResult(rt, result, rt.json);
}

export function renderEstimate(e: CliEstimate, policy: LoadedPolicy): string {
  const lines: string[] = [];
  lines.push(
    `Tier ${e.tier.level} (score ${e.tier.score})${e.tier.reasons.length ? `: ${e.tier.reasons.join("; ")}` : ""}`,
  );
  if (e.triaged) {
    lines.push(`Triage: auto-pass, no model calls (${e.triaged.reason})`);
    return lines.join("\n");
  }
  const hunters = e.seats.filter((s) => s.role === "hunter").length;
  lines.push(
    `Panel: ${hunters} hunter${hunters === 1 ? "" : "s"}, ${e.seats.length - hunters} judge seat${e.seats.length - hunters === 1 ? "" : "s"}`,
  );
  if (e.seats.length) {
    lines.push(
      table(
        ["seat", "lens", "connection", "model", "est."],
        e.seats.map((s) => [
          s.id,
          s.lens,
          s.connectionId,
          `${s.model}${s.downgradedFrom ? ` (downgraded from ${s.downgradedFrom})` : ""}`,
          formatUsd(s.usd),
        ]),
      ),
    );
  }
  lines.push(
    `Estimated cost: ${formatUsd(e.usd)}${e.unknownSeats.length ? ` (not priced: ${e.unknownSeats.join(", ")})` : ""}`,
  );
  const shown = e.ceilings.filter((c) => c.limitUsd !== null && c.limitUsd > 0);
  if (shown.length) {
    lines.push("Ceilings:");
    for (const c of shown) {
      const state = c.breached ? (c.advisory ? "over (advisory)" : "OVER") : "ok";
      lines.push(
        `  ${c.ceiling.padEnd(10)} ${formatUsd(c.projectedUsd)} projected of ${formatUsd(c.limitUsd ?? undefined)} (${formatUsd(c.currentUsd)} spent)  ${state}`,
      );
    }
  } else {
    const b = policy.policy.budget;
    lines.push(`Ceilings: ${formatUsd(b.perSeatUsd)} per seat, ${formatUsd(b.perChangeUsd)} per change`);
  }
  for (const d of e.downgrades)
    lines.push(`Downgrade: ${d.step}${d.from ? ` ${d.from} -> ${d.to ?? "?"}` : ""} (${d.reason})`);
  lines.push(e.admitted ? "Admission: would run" : `Admission: would be refused: ${e.blockedReason ?? "over budget"}`);
  for (const w of e.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

export async function estimateCommand(rt: Runtime, opts: RunOptions): Promise<number> {
  let gate: CliGate;
  let est: CliEstimate;
  let policy: LoadedPolicy;
  if (opts.local) {
    const lc = await localInput(rt, opts.base);
    policy = await localPolicy(lc, opts.policy);
    gate = await makeGate(rt, { mode: "local", root: lc.root }, policy);
    est = await gate.estimate({ change: lc.change, diff: lc.diff, untrusted: lc.untrusted });
  } else {
    const c = await prContext(rt, opts);
    policy = c.policy;
    gate = await makeGate(rt, { ...prTarget(rt, c, { ...opts, store: opts.store ?? "fs" }), dryRun: true }, policy);
    est = await gate.estimate(c.ref);
  }
  if (rt.json) rt.printJson({ ...est, policy: { source: policy.source, hash: policy.hash } });
  else rt.out(rt.secrets.scrub(renderEstimate(est, policy)));
  return est.admitted ? EXIT.pass : EXIT.budgetBlocked;
}

export async function explainCommand(rt: Runtime, opts: RunOptions): Promise<number> {
  const c = await prContext(rt, opts);
  const gate = await makeGate(rt, prTarget(rt, c, opts), c.policy);
  const found = await gate.explain(c.ref);
  if (!found) {
    const msg = `No verdict recorded for ${c.ref.repo.owner}/${c.ref.repo.name}#${c.ref.number} in the ${opts.store ?? "fs"} store.`;
    if (rt.json) rt.printJson({ found: false, message: msg });
    else rt.out(msg);
    return EXIT.pending;
  }
  if (rt.json) rt.printJson({ found: true, verdict: found.verdict });
  else rt.out(rt.secrets.scrub(found.digest.text));
  return exitFor(found.verdict.contested ? "contested" : found.verdict.decision);
}

export interface VerdictOptions extends RunOptions {
  sha?: string;
  decision?: string;
  reason?: string;
  as?: string;
}

/** `--as`, else the login of the `gh` CLI user, else GITHUB_ACTOR. */
export async function resolveSigner(rt: Runtime, as: string | undefined): Promise<Principal> {
  if (as?.trim()) return { kind: "human", login: as.trim() };
  const r = await rt.ctx.exec("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  const login = r.code === 0 ? r.stdout.trim() : "";
  if (login && /^[A-Za-z0-9-]+(\[bot\])?$/.test(login)) return { kind: "human", login };
  const actor = rt.ctx.env.GITHUB_ACTOR?.trim();
  if (actor) return { kind: "human", login: actor };
  throw new CliError(
    "SIGNER_UNKNOWN",
    "cannot tell who is signing: pass --as <login>, log in with `gh`, or set GITHUB_ACTOR",
  );
}

export async function verdictCommand(rt: Runtime, opts: VerdictOptions): Promise<number> {
  const decision = opts.decision;
  if (decision !== "pass" && decision !== "block") throw new CliError("USAGE", "--decision must be pass or block");
  const sha = opts.sha?.trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) throw new CliError("USAGE", "--sha <commit sha> is required");
  const reason = opts.reason?.trim();
  if (!reason) throw new CliError("USAGE", "--reason <text> is required: say what you checked");
  const signedBy = await resolveSigner(rt, opts.as);
  const c = await prContext(rt, { ...opts, head: sha });
  const gate = await makeGate(rt, prTarget(rt, c, opts), c.policy);
  const v = await gate.recordHumanVerdict({ ref: c.ref, headSha: sha, decision, signedBy, reason });
  if (rt.json) rt.printJson({ verdict: v });
  else {
    rt.out(
      `Recorded human ${v.decision.toUpperCase()} for ${c.ref.repo.owner}/${c.ref.repo.name}#${c.ref.number} at ${v.headSha.slice(0, 12)}, signed by ${signedBy.login}.`,
    );
  }
  return EXIT.pass;
}
