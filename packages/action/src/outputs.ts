/** Step outputs and the job summary for a review. */
import type { CliReviewResult } from "@merge-safely/cli";
import type { Verdict } from "@merge-safely/core";

export interface ActionOutputs {
  decision: string;
  tier: string;
  round: string;
  "cost-usd": string;
  "check-url": string;
  "verdict-json": string;
}

/** A compact, stable projection of the verdict for `verdict-json` (seats and audits are in the check run). */
export function compactVerdict(v: Verdict): Record<string, unknown> {
  return {
    decision: v.decision,
    kind: v.kind,
    repo: `${v.repo.owner}/${v.repo.name}`,
    number: v.number,
    headSha: v.headSha,
    round: v.round,
    tier: v.tier.level,
    triaged: v.triaged,
    ...(v.contested ? { contested: true } : {}),
    quorum: v.quorum,
    findings: v.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      class: f.class,
      title: f.title,
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
    })),
    ...(v.cost.usd !== undefined ? { costUsd: v.cost.usd } : {}),
    tokens: v.cost.tokens,
    ...(v.downgrades?.length ? { downgrades: v.downgrades.map((d) => d.step) } : {}),
    policyHash: v.policyHash,
    createdAt: v.createdAt,
  };
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return "unpriced";
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** One line: dollars, tokens, seats, connections and downgrades (design 7.6). */
export function costLine(v: Verdict): string {
  const conns = new Map<string, number>();
  for (const s of Object.values(v.cost.bySeat)) conns.set(s.connectionId, (conns.get(s.connectionId) ?? 0) + 1);
  const parts = [
    formatCost(v.cost.usd),
    `${v.cost.tokens.in.toLocaleString("en-US")} tokens in / ${v.cost.tokens.out.toLocaleString("en-US")} out`,
    `${v.seats.length} seat${v.seats.length === 1 ? "" : "s"}`,
  ];
  if (conns.size) parts.push([...conns].map(([c, n]) => `${c}: ${n}`).join(", "));
  if (v.downgrades?.length) parts.push(`downgraded (${v.downgrades.map((d) => d.step).join(", ")})`);
  return `**Cost:** ${parts.join(" · ")}`;
}

export function reviewOutputs(r: CliReviewResult, checkUrl: string | undefined): ActionOutputs {
  const v = r.verdict;
  return {
    decision: r.outcome,
    tier: v ? String(v.tier.level) : r.tier ? String(r.tier.level) : "",
    round: v ? String(v.round) : "",
    "cost-usd": v?.cost.usd !== undefined ? v.cost.usd.toFixed(6) : "",
    "check-url": checkUrl ?? "",
    "verdict-json": v ? JSON.stringify(compactVerdict(v)) : "",
  };
}

/** Job summary: the digest, the cost line (unless the digest already carries one), and the check link. */
export function reviewSummary(r: CliReviewResult, checkUrl: string | undefined): string {
  const parts = [r.digest.markdown.trim() || `## ${r.digest.headline}`];
  if (r.reason && !r.digest.markdown.includes(r.reason)) parts.push(`> ${r.reason}`);
  if (r.verdict && !r.digest.markdown.includes("**Cost:**")) parts.push(costLine(r.verdict));
  if (checkUrl) parts.push(`[Verdict check run](${checkUrl})`);
  return `${parts.join("\n\n")}\n`;
}
