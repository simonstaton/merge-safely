import { createHash } from "node:crypto";
import type { Finding, RepoRef, ReviewerRun, Verdict, VerdictKey, VerdictStore } from "@merge-safely/core";
import { conclusionForVerdict, findCheckRun } from "./check-run-shared.js";
import { type CheckRunData, collectPages, type OctokitLike } from "./octokit.js";
import { clip, DEFAULT_CHECK_NAME, GITHUB_TEXT_LIMIT } from "./util.js";

/**
 * VerdictStore that lives inside the check run itself (design 6.1): the Action needs no database.
 *
 * Layout of `output.text` (GitHub caps it at 65,535 characters):
 *
 *     <!-- merge-safely:verdict -->
 *     ```json
 *     {...compact verdict...}
 *     ```
 *
 * Compaction: per-seat outputs are reduced to verdict + clipped summary (their findings are already
 * aggregated into `verdict.findings`), judge outputs to their votes, and `audit.filesRead` /
 * `audit.commandsRun` to 20 entries each. If the JSON still does not fit, further levels drop the
 * audit lists, clip finding detail and evidence, and finally drop `seats` altogether. Findings,
 * quorum, cost, downgrades and addressed/carried are always kept.
 *
 * Concurrency: GitHub has no conditional update, so put() is read-compare-write. It catches stale
 * writers (the common race) but not two writers inside the same few hundred milliseconds; run one
 * review per SHA at a time (an Actions `concurrency` group or the App's queue).
 */
export interface CheckRunStoreOptions {
  octokit: OctokitLike;
  checkName?: string;
}

export const VERDICT_MARKER = "<!-- merge-safely:verdict -->";
const KEEP_LIST = 20;

const DECISIONS = ["pass", "block", "pending"];
const KINDS = ["machine", "human"];

function compactRun(r: ReviewerRun, level: number): ReviewerRun {
  const listCap = level >= 1 ? 0 : KEEP_LIST;
  const out: ReviewerRun = {
    seat: r.seat,
    headSha: r.headSha,
    round: r.round,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    output: r.output
      ? { verdict: r.output.verdict, summary: clip(r.output.summary, level >= 1 ? 200 : 500), findings: [] }
      : null,
    audit: {
      ...r.audit,
      filesRead: r.audit.filesRead.slice(0, listCap),
      commandsRun: r.audit.commandsRun.slice(0, listCap),
    },
  };
  if (r.judgeOutput !== undefined) {
    out.judgeOutput = r.judgeOutput
      ? {
          votes: r.judgeOutput.votes.map((v) =>
            level >= 1
              ? { findingId: v.findingId, decision: v.decision, ...(v.severity ? { severity: v.severity } : {}) }
              : v.reason
                ? { ...v, reason: clip(v.reason, 300) }
                : v,
          ),
        }
      : null;
  }
  if (r.error) out.error = clip(r.error, 500);
  if (r.fallbackUsed) out.fallbackUsed = r.fallbackUsed;
  return out;
}

function compactFinding(f: Finding, level: number): Finding {
  if (level < 2) return f;
  const detailMax = level >= 3 ? 300 : 1500;
  const out: Finding = { ...f, detail: clip(f.detail, detailMax) };
  if (f.evidence) out.evidence = level >= 3 ? [] : f.evidence.slice(0, 3).map((e) => clip(e, 300));
  if (f.suggestedFix) out.suggestedFix = clip(f.suggestedFix, level >= 3 ? 200 : 800);
  if (level >= 3) delete out.votes;
  return out;
}

function compactVerdict(v: Verdict, level: number): Verdict {
  return {
    ...v,
    seats: level >= 3 ? [] : v.seats.map((s) => compactRun(s, level)),
    findings: v.findings.map((f) => compactFinding(f, level)),
  };
}

function wrap(json: string): string {
  return `${VERDICT_MARKER}\n\`\`\`json\n${json}\n\`\`\``;
}

/** Serialise a verdict into the compact, fenced block stored in `output.text`, guaranteed ≤ 65,535 chars. */
export function serializeVerdict(v: Verdict): string {
  for (let level = 0; level <= 3; level++) {
    const text = wrap(JSON.stringify(compactVerdict(v, level)));
    if (text.length <= GITHUB_TEXT_LIMIT) return text;
  }
  // Pathological: thousands of findings. Keep the most severe ones that fit; the decision is unchanged.
  const order = ["blocker", "important", "nit", "pre-existing"];
  const sorted = [...v.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const base = compactVerdict({ ...v, findings: sorted }, 3);
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const text = wrap(JSON.stringify({ ...base, findings: base.findings.slice(0, mid) }));
    if (text.length <= GITHUB_TEXT_LIMIT) lo = mid;
    else hi = mid - 1;
  }
  return wrap(JSON.stringify({ ...base, findings: base.findings.slice(0, lo) }));
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Parse the verdict block out of `output.text`. Returns null for missing, garbled or wrongly-shaped data. */
export function parseVerdictText(text: string | null | undefined): Verdict | null {
  if (!text) return null;
  const at = text.indexOf(VERDICT_MARKER);
  if (at < 0) return null;
  const m = /^\s*```json\s*\n([\s\S]*?)\n```/.exec(text.slice(at + VERDICT_MARKER.length));
  if (!m?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (_err: unknown) {
    return null;
  }
  if (!isObj(raw)) return null;
  const repo = raw.repo;
  const ok =
    isObj(repo) &&
    typeof repo.host === "string" &&
    typeof repo.owner === "string" &&
    typeof repo.name === "string" &&
    typeof raw.number === "number" &&
    typeof raw.headSha === "string" &&
    typeof raw.kind === "string" &&
    KINDS.includes(raw.kind) &&
    typeof raw.decision === "string" &&
    DECISIONS.includes(raw.decision) &&
    typeof raw.round === "number" &&
    typeof raw.triaged === "boolean" &&
    isObj(raw.tier) &&
    Array.isArray(raw.seats) &&
    Array.isArray(raw.findings) &&
    raw.findings.every((f) => isObj(f) && typeof f.id === "string" && typeof f.severity === "string") &&
    isObj(raw.quorum) &&
    isObj(raw.cost) &&
    typeof raw.createdAt === "string" &&
    typeof raw.policyHash === "string";
  return ok ? (raw as unknown as Verdict) : null;
}

/**
 * Version token for CAS: check run id + its completion (or start) time + a short hash of the stored
 * text. The hash is there because writing output.text does not move completed_at, so id+time alone
 * would let two writers both "win".
 */
export function checkRunVersion(run: CheckRunData): string {
  const text = run.output.text ?? "";
  const h = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${run.id}:${run.completed_at ?? run.started_at ?? ""}:${h}`;
}

function minimalSummary(v: Verdict): { title: string; summary: string } {
  const title = `Verdict: ${v.decision.toUpperCase()} (tier ${v.tier.level}, round ${v.round})`;
  const blockers = v.findings.filter((f) => f.severity === "blocker").length;
  return { title, summary: `${title}\n\n${v.findings.length} findings, ${blockers} blockers.` };
}

export function checkRunStore(opts: CheckRunStoreOptions): VerdictStore {
  const { octokit } = opts;
  const name = opts.checkName ?? DEFAULT_CHECK_NAME;

  async function read(repo: RepoRef, headSha: string) {
    const run = await findCheckRun(octokit, repo, headSha, name);
    if (!run) return { run: null, verdict: null };
    return { run, verdict: parseVerdictText(run.output.text) };
  }

  const matches = (v: Verdict, key: VerdictKey) =>
    v.headSha === key.headSha &&
    v.number === key.number &&
    v.repo.owner.toLowerCase() === key.repo.owner.toLowerCase() &&
    v.repo.name.toLowerCase() === key.repo.name.toLowerCase();

  return {
    async get(key) {
      const { run, verdict } = await read(key.repo, key.headSha);
      if (!run || !verdict || !matches(verdict, key)) return null;
      return { verdict, version: checkRunVersion(run) };
    },

    async put(v, expect) {
      const { run, verdict } = await read(v.repo, v.headSha);
      const current = run && verdict ? checkRunVersion(run) : null;
      if (current !== expect.version) return { ok: false, version: current ?? "" };
      const text = serializeVerdict(v);
      const fallback = minimalSummary(v);
      if (run) {
        const { data } = await octokit.checks.update({
          owner: v.repo.owner,
          repo: v.repo.name,
          check_run_id: run.id,
          output: {
            title: run.output.title ?? fallback.title,
            summary: run.output.summary ?? fallback.summary,
            text,
          },
        });
        return { ok: true, version: checkRunVersion(data) };
      }
      // No run yet: the store is the signal, so create it completed with the verdict's conclusion.
      // A reporter that runs later finds this run and enriches title/summary/annotations.
      const { data } = await octokit.checks.create({
        owner: v.repo.owner,
        repo: v.repo.name,
        name,
        head_sha: v.headSha,
        status: "completed",
        conclusion: conclusionForVerdict(v),
        completed_at: v.createdAt,
        output: { ...fallback, text },
      });
      return { ok: true, version: checkRunVersion(data) };
    },

    async listForChange(repo, number) {
      const commits = await collectPages(
        async (page, per_page) =>
          (await octokit.pulls.listCommits({ owner: repo.owner, repo: repo.name, pull_number: number, per_page, page }))
            .data,
        { maxItems: 250 },
      );
      const out: Verdict[] = [];
      for (const c of commits) {
        const { verdict } = await read(repo, c.sha);
        if (verdict && verdict.number === number) out.push(verdict);
      }
      return out; // commit order: oldest first, newest last
    },
  };
}
