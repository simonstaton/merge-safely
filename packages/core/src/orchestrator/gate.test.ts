import { describe, expect, it } from "vitest";
import { REVIEWER_OUTPUT_JSON_SCHEMA } from "../schema/reviewer-output.js";
import { assignFingerprints, fingerprintFinding } from "../stages/fingerprint.js";
import { makeFinding, makePolicy, makeVerdict } from "../stages/test-helpers.js";
import { tier } from "../stages/tiering.js";
import type { Finding, JudgeDecision, ReviewerInput, Verdict } from "../types.js";
import { GateError } from "./errors.js";
import {
  API_KEY,
  BACKUP,
  docsChange,
  FakeTrust,
  MAIN,
  makeHarness,
  passOutput,
  type Script,
  SHA_A,
  SHA_B,
  ThrowingReporter,
  tier1Change,
  tier3Change,
} from "./test-fakes.js";

const T1_PANEL = { hunters: ["correctness", "repro"], judges: 1 };
const T3_PANEL = { hunters: ["correctness", "security"], judges: 2, secondJudgeRound: true };
const basePolicy = (extra: Parameters<typeof makePolicy>[0] = {}) =>
  makePolicy({ panel: { t1: T1_PANEL, t3: T3_PANEL }, ...extra });

const blockerDraft = (extra: Partial<Finding> = {}): Finding =>
  makeFinding({
    severity: "blocker",
    class: "logic-error",
    title: "Null dereference on empty cart",
    detail: "cart.items is undefined when the cart is empty.",
    file: "src/lib/f1.ts",
    line: 12,
    ...extra,
  });

/** Judges vote `decide(finding)` on every candidate they are shown. */
const judgeVotes =
  (decide: (f: Finding, input: ReviewerInput, seatId: string) => JudgeDecision): Script =>
  (call) => ({
    judgeOutput: {
      votes: (call.input.candidateFindings ?? []).map((f) => ({
        findingId: f.id,
        decision: decide(f, call.input, call.seat.id),
      })),
    },
  });

const hunterThenJudge =
  (hunter: Script, judge: Script): Script =>
  (call) =>
    call.seat.role === "judge" ? judge(call) : hunter(call);

const storedVerdicts = (h: ReturnType<typeof makeHarness>): Verdict[] =>
  [...h.store.slots.values()].map((s) => s.verdict);

describe("createGate: triage", () => {
  it("auto-passes a docs-only change with zero seats and reports pending then verdict", async () => {
    const h = makeHarness({ policy: basePolicy(), change: docsChange() });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(r.verdict.triaged).toBe(true);
    expect(r.verdict.seats).toEqual([]);
    expect(r.verdict.quorum).toEqual({ required: 0, passed: 0, blocked: 0, invalid: 0 });
    expect(r.verdict.triageReason).toMatch(/docs-only/);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.workspace.acquired).toBe(0);
    expect(h.reporter.types()).toEqual(["pending", "verdict"]);
    expect(r.events.map((e) => e.type)).toEqual(["pending", "verdict"]);
    expect(storedVerdicts(h)).toHaveLength(1);
  });
});

describe("createGate: review panel", () => {
  it("passes a tier 1 change with proof of work, cost and a stored verdict", async () => {
    const policy = basePolicy({ runner: { allowedCommands: ["npm test"] } });
    const h = makeHarness({ policy });
    const r = await h.gate.review(h.ref, { trigger: "pull_request.opened" });
    expect(r.verdict.tier.level).toBe(1);
    expect(r.verdict.decision).toBe("pass");
    expect(r.verdict.seats.map((s) => s.seat.id)).toEqual(["hunter:correctness:1", "hunter:repro:1"]);
    expect(r.verdict.seats.every((s) => s.status === "ok" && s.audit.filesRead.length > 0)).toBe(true);
    expect(r.verdict.quorum).toEqual({ required: 1, passed: 2, blocked: 0, invalid: 0 });
    // No candidates, so the judge seat never ran.
    expect(h.provider.calls.map((c) => c.seat.role)).toEqual(["hunter", "hunter"]);
    const input = h.provider.calls[0]?.input as ReviewerInput;
    expect(input.outputSchema).toBe(REVIEWER_OUTPUT_JSON_SCHEMA);
    expect(input.allowedCommands).toEqual(["npm test"]);
    expect(input.diffIsDelta).toBe(false);
    expect(input.prompt.system).toContain("hunter:correctness");
    expect(input.prompt.system).toContain("read_file");
    expect(h.toolOptions.every((o) => o.allowedCommands?.includes("npm test"))).toBe(true);
    expect(h.source.diffCalls).toEqual([{ headSha: SHA_A }]);
    expect(Object.keys(r.verdict.cost.bySeat).sort()).toEqual(["hunter:correctness:1", "hunter:repro:1"]);
    expect(r.verdict.cost.usd).toBeGreaterThan(0);
    expect(r.verdict.cost.tokens).toEqual({ in: 2000, out: 200 });
    expect(r.verdict.policyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(h.reporter.types()).toEqual(["pending", "verdict"]);
    expect(r.digest.headline).toMatch(/PASS/);
    const stored = await h.store.get({ repo: h.ref.repo, number: h.ref.number, headSha: SHA_A });
    expect(stored?.verdict.decision).toBe("pass");
    expect(h.escalation.requests).toHaveLength(0);
    expect(h.metrics.named("merge_safely.review.verdict")).toHaveLength(1);
    expect(h.metrics.named("merge_safely.review.time_to_verdict_ms")[0]?.value).toBeGreaterThan(0);
  });

  it("blocks a tier 3 change on one confirmed blocker, redacts it and escalates for a standard author", async () => {
    const script = hunterThenJudge(
      (call) =>
        call.seat.lens === "correctness"
          ? {
              output: {
                verdict: "block",
                summary: "Found a crash.",
                findings: [blockerDraft({ id: "model-made-this-up", detail: "Key AKIAABCDEFGHIJKLMNOP leaks" })],
              },
            }
          : { output: passOutput() },
      judgeVotes(() => "confirm"),
    );
    const h = makeHarness({ policy: basePolicy(), change: tier3Change(), script });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.tier.level).toBe(3);
    expect(r.verdict.decision).toBe("block");
    expect(r.verdict.findings).toHaveLength(1);
    const f = r.verdict.findings[0] as Finding;
    expect(f.id).toBe(fingerprintFinding(blockerDraft()));
    expect(f.detail).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(f.lenses).toEqual(["correctness"]);
    expect(f.votes?.map((v) => v.decision)).toEqual(["confirm", "confirm"]);
    expect(r.verdict.escalated).toBe(true);
    expect(h.escalation.requests).toHaveLength(1);
    expect(r.escalation?.id).toBe("esc-1");
    expect(h.reporter.types()).toEqual(["pending", "verdict", "escalated"]);
  });

  it("passes when the judges refute every candidate", async () => {
    const script = hunterThenJudge(
      (call) =>
        call.seat.lens === "correctness"
          ? { output: { verdict: "block", summary: "x", findings: [blockerDraft()] } }
          : { output: passOutput() },
      judgeVotes(() => "refute"),
    );
    const h = makeHarness({ policy: basePolicy(), script });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(r.verdict.findings).toEqual([]);
    expect(r.verdict.quorum).toEqual({ required: 1, passed: 1, blocked: 0, invalid: 1 });
    expect(r.verdict.seats.map((s) => s.seat.role)).toEqual(["hunter", "hunter", "judge"]);
  });

  it("goes pending, reports an error and escalates when every seat errors", async () => {
    const h = makeHarness({ policy: basePolicy(), script: () => ({ status: "error", output: null, error: "429" }) });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.quorum.invalid).toBe(2);
    expect(h.reporter.types()).toEqual(["pending", "error", "verdict", "escalated"]);
    expect(h.escalation.requests).toHaveLength(1);
    const stored = storedVerdicts(h);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.decision).toBe("pending");
  });

  it("does not escalate a trusted author's tier 2 block and leaves the tier unchanged", async () => {
    const policy = basePolicy({ tiers: { thresholds: { t1: 10, t2: 20, t3: 80 } } });
    const change = tier1Change();
    expect(tier(change, policy).level).toBe(2);
    const script = hunterThenJudge(
      (call) =>
        call.seat.lens === "correctness"
          ? { output: { verdict: "block", summary: "x", findings: [blockerDraft()] } }
          : { output: passOutput() },
      judgeVotes(() => "confirm"),
    );
    const h = makeHarness({ policy, change, script, deps: { trust: new FakeTrust("trusted") } });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("block");
    expect(r.verdict.tier.level).toBe(2);
    expect(r.verdict.reason).toMatch(/light path/);
    expect(r.verdict.escalated).toBeUndefined();
    expect(h.escalation.requests).toHaveLength(0);
  });

  it("never treats a bot as trusted when botsAreStandard", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      change: tier1Change({ author: { kind: "bot", login: "renovate[bot]" } }),
      script: () => ({ status: "error", output: null }),
      deps: { trust: new FakeTrust("trusted") },
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.reason ?? "").not.toMatch(/light path/);
    expect(h.escalation.requests).toHaveLength(1);
  });

  it("falls back to policy.models.fallback after a provider error and records fallbackUsed", async () => {
    const policy = basePolicy({
      models: { decorrelate: false, fallback: { connection: "backup", model: "gpt-x" } },
    });
    const h = makeHarness({
      policy,
      connections: [MAIN, BACKUP],
      script: () => ({ status: "error", output: null, error: "upstream 503" }),
      backupScript: () => ({ output: passOutput() }),
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    for (const run of r.verdict.seats) {
      expect(run.fallbackUsed).toEqual({ connectionId: "backup", provider: "openai", name: "gpt-x" });
      expect(run.seat.model.connectionId).toBe("main");
    }
    expect(r.verdict.cost.bySeat["hunter:correctness:1"]?.connectionId).toBe("backup");
    expect(h.provider.calls).toHaveLength(2);
    expect(h.backupProvider.calls).toHaveLength(2);
    // Both attempts were paid for and both are in the ledger.
    expect(h.ledger.rows.map((row) => row.connectionId).sort()).toEqual(["backup", "backup", "main", "main"]);
    expect(h.workspace.acquired).toBe(2);
    expect(h.workspace.disposed).toBe(2);
  });

  it("streams ledger rows keyed by seat, lens and connection", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      script: () => ({
        output: passOutput(),
        usage: [{ tokens: { in: 500, out: 50 } }, { tokens: { in: 300, out: 30 }, usd: 0.5 }],
      }),
    });
    await h.gate.review(h.ref);
    expect(h.ledger.rows).toHaveLength(4);
    const seats = [...new Set(h.ledger.rows.map((r) => `${r.seatId}|${r.lens}|${r.connectionId}`))].sort();
    expect(seats).toEqual(["hunter:correctness:1|correctness|main", "hunter:repro:1|repro|main"]);
    for (const row of h.ledger.rows) {
      expect(row).toMatchObject({ headSha: SHA_A, round: 1, provider: "anthropic", model: "sonnet-x" });
      expect(row.installationId).toBe("inst-1");
    }
    const priced = h.ledger.rows.find((r) => r.tokens.in === 500);
    expect(priced?.usd).toBeCloseTo((500 * 3 + 50 * 15) / 1e6, 10);
    expect(priced?.estimated).toBe(false);
    expect(h.ledger.rows.find((r) => r.tokens.in === 300)?.usd).toBe(0.5);
  });

  it("isolates a reporter that throws", async () => {
    const throwing = new ThrowingReporter();
    const h = makeHarness({ policy: basePolicy() });
    const deps = { ...h.deps, reporters: [throwing, h.reporter] };
    const { createGate } = await import("./gate.js");
    const r = await createGate(deps).review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(throwing.calls).toBe(2);
    expect(h.reporter.types()).toEqual(["pending", "verdict"]);
  });

  it("disposes every workspace even when the runner throws, and scrubs secrets from the error", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      script: (call) =>
        call.seat.lens === "repro" ? new Error(`connect failed with key ${API_KEY}`) : { output: passOutput() },
    });
    const r = await h.gate.review(h.ref);
    expect(h.workspace.acquired).toBe(2);
    expect(h.workspace.disposed).toBe(2);
    const failed = r.verdict.seats.find((s) => s.seat.lens === "repro");
    expect(failed?.status).toBe("error");
    expect(failed?.error).toBeDefined();
    expect(JSON.stringify(r.verdict)).not.toContain(API_KEY);
    expect(r.verdict.decision).toBe("pass");
  });

  it("reruns judges only on split findings when secondJudgeRound is on", async () => {
    const f1 = blockerDraft({ title: "Crash one", line: 5 });
    const f2 = blockerDraft({ title: "Crash two", class: "race", severity: "important", line: 40 });
    const [id1, id2] = assignFingerprints([f1, f2]).map((f) => f.id);
    const script = hunterThenJudge(
      (call) =>
        call.seat.lens === "correctness"
          ? { output: { verdict: "block", summary: "x", findings: [f1, f2] } }
          : { output: passOutput() },
      judgeVotes((f, input, seatId) => {
        const secondRound = (input.candidateFindings ?? []).length === 1;
        if (secondRound) return "confirm";
        return seatId === "judge:2" && f.id === id2 ? "refute" : "confirm";
      }),
    );
    const h = makeHarness({ policy: basePolicy(), change: tier3Change(), script });
    const r = await h.gate.review(h.ref);
    const judgeCalls = h.provider.calls.filter((c) => c.seat.role === "judge");
    expect(judgeCalls).toHaveLength(4);
    const shown = judgeCalls.map((c) => (c.input.candidateFindings ?? []).map((f) => f.id).sort());
    expect(shown.filter((ids) => ids.length === 2)).toHaveLength(2);
    expect(shown.filter((ids) => ids.length === 1)).toEqual([[id2], [id2]]);
    expect(h.workspace.seatIds).toContain("judge:1:second");
    const survived = r.verdict.findings.map((f) => f.id).sort();
    expect(survived).toEqual([id1, id2].sort());
    const judgeRuns = r.verdict.seats.filter((s) => s.seat.role === "judge");
    expect(judgeRuns).toHaveLength(2);
  });

  it("works without a source port via reviewChange", async () => {
    const h = makeHarness({ policy: basePolicy(), deps: { source: undefined } });
    const r = await h.gate.reviewChange(tier1Change(), { diff: "diff --git a/y b/y\n+y" });
    expect(r.verdict.decision).toBe("pass");
    expect(h.provider.calls[0]?.input.diff).toContain("+y");
    await expect(h.gate.review(h.ref)).rejects.toMatchObject({ code: "source" });
  });
});

describe("createGate: budgets", () => {
  const fixedUsage = { estimateUsage: () => ({ in: 100_000, out: 10_000 }) };

  it("walks the downgrade ladder on a per-change breach and runs the cheaper models", async () => {
    const policy = basePolicy({
      models: {
        hunters: { connection: "main", model: "opus-x" },
        judges: { connection: "main", model: "opus-x" },
      },
      budget: { perChangeUsd: 4 },
    });
    const h = makeHarness({ policy, deps: fixedUsage });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(r.verdict.downgrades?.map((d) => d.step)).toEqual(["hunters-model"]);
    expect(h.provider.calls.map((c) => c.model)).toEqual(["sonnet-x", "sonnet-x"]);
    expect(r.verdict.seats.every((s) => s.seat.downgradedFrom?.name === "opus-x")).toBe(true);
    expect(r.digest.markdown).toMatch(/Downgrades applied/);
  });

  it("refuses at admission on a window breach: budget-blocked, pending, nothing stored", async () => {
    const policy = basePolicy({ budget: { windowUsd: 1, windowDays: 7 } });
    const h = makeHarness({ policy, deps: fixedUsage });
    await h.ledger.append({
      at: new Date(h.clock.now().getTime() - 1000).toISOString(),
      repo: h.ref.repo,
      number: 7,
      headSha: SHA_B,
      round: 1,
      seatId: "hunter:correctness:1",
      lens: "correctness",
      connectionId: "main",
      provider: "anthropic",
      model: "sonnet-x",
      tokens: { in: 1, out: 1 },
      usd: 2,
      estimated: false,
      installationId: "inst-1",
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.reason).toMatch(/budget\.windowUsd/);
    expect(h.reporter.types()).toEqual(["pending", "budget-blocked"]);
    const ev = h.reporter.events[1];
    expect(ev?.type === "budget-blocked" && ev.ceiling).toBe("window");
    expect(r.digest.headline).toMatch(/BLOCKED BY BUDGET/);
    expect(r.digest.markdown).toContain("budget.windowUsd");
    expect(storedVerdicts(h)).toHaveLength(0);
    expect(h.provider.calls).toHaveLength(0);
  });

  it("fails closed when an installation ceiling is configured but there is no ledger", async () => {
    const policy = basePolicy({ budget: { spendLimitUsd: 100 } });
    const h = makeHarness({ policy, deps: { ledger: undefined } });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(h.reporter.types()).toEqual(["pending", "budget-blocked"]);
  });

  it("treats advisory ceilings as warnings only", async () => {
    const policy = basePolicy({ budget: { perInstallationMonthlyUsd: 0.000001 } });
    const h = makeHarness({ policy, deps: { ...fixedUsage, advisoryCeilings: ["monthly"] } });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
  });
});

describe("createGate: rounds", () => {
  const known = assignFingerprints([
    makeFinding({ severity: "important", class: "logic-error", title: "Wrong total", file: "src/lib/f2.ts", line: 3 }),
    makeFinding({ severity: "nit", class: "naming", title: "Odd name", file: "src/lib/f3.ts", line: 8 }),
  ]);
  const round1 = (findings: Finding[], decision: Verdict["decision"] = "block"): Verdict =>
    makeVerdict({
      repo: tier1Change().repo,
      number: tier1Change().number,
      headSha: SHA_A,
      decision,
      round: 1,
      findings,
      seats: [
        {
          seat: {
            id: "hunter:correctness:1",
            lens: "correctness",
            role: "hunter",
            model: { connectionId: "main", provider: "anthropic", name: "sonnet-x" },
            budget: { maxTurns: 50, deadlineMs: 60_000 },
          },
          headSha: SHA_A,
          round: 1,
          output: { verdict: "block", summary: "x", findings },
          audit: {
            substantiveCalls: 5,
            totalCalls: 5,
            filesRead: ["a"],
            commandsRun: [],
            tokens: { in: 1, out: 1 },
            wallMs: 1,
            turns: 1,
          },
          status: "ok",
          startedAt: "2026-05-01T00:00:00.000Z",
          finishedAt: "2026-05-01T00:00:01.000Z",
        },
      ],
    });

  it("reviews only the delta in round 2 and computes addressed/carried", async () => {
    const [k1, k2] = known as [Finding, Finding];
    const h = makeHarness({
      policy: basePolicy(),
      change: tier1Change({ headSha: SHA_B }),
      diffs: { full: "FULL", delta: "DELTA" },
      script: () => ({ output: passOutput({ addressed: [k1.id] }) }),
    });
    h.store.seed(round1(known));
    const r = await h.gate.review(h.ref);
    expect(r.verdict.round).toBe(2);
    expect(h.source.diffCalls).toEqual([{ sinceSha: SHA_A, headSha: SHA_B }]);
    const input = h.provider.calls[0]?.input as ReviewerInput;
    expect(input.diffIsDelta).toBe(true);
    expect(input.diff).toBe("DELTA");
    expect(input.prompt.user).toContain(`since ${SHA_A}`);
    expect(input.knownFindings.map((f) => f.id).sort()).toEqual([k1.id, k2.id].sort());
    expect(r.verdict.addressed).toEqual([k1.id]);
    expect(r.verdict.carried).toEqual([k2.id]);
    expect(r.verdict.decision).toBe("pass");
    expect(r.verdict.findings.map((f) => f.id)).toEqual([k2.id]);
  });

  it("keeps blocking on a carried blocker nobody addressed", async () => {
    const blocker = assignFingerprints([blockerDraft()])[0] as Finding;
    const h = makeHarness({ policy: basePolicy(), change: tier1Change({ headSha: SHA_B }) });
    h.store.seed(round1([blocker]));
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("block");
    expect(r.verdict.carried).toEqual([blocker.id]);
    expect(r.verdict.findings.map((f) => f.id)).toEqual([blocker.id]);
  });

  it("marks a same-SHA pass after a stored block as contested and keeps the stored block", async () => {
    const draft = blockerDraft();
    const id = fingerprintFinding(draft);
    let pass = false;
    const script = hunterThenJudge(
      (call) =>
        pass
          ? { output: passOutput({ addressed: [id] }) }
          : call.seat.lens === "correctness"
            ? { output: { verdict: "block", summary: "x", findings: [draft] } }
            : { output: passOutput() },
      judgeVotes(() => "confirm"),
    );
    const h = makeHarness({ policy: basePolicy(), script });
    const first = await h.gate.review(h.ref);
    expect(first.verdict.decision).toBe("block");
    const before = await h.store.get({ repo: h.ref.repo, number: h.ref.number, headSha: SHA_A });
    pass = true;
    const second = await h.gate.review(h.ref);
    expect(second.contested).toBe(true);
    expect(second.verdict.decision).toBe("block");
    expect(second.verdict.round).toBe(1);
    expect(second.digest.headline).toMatch(/CONTESTED/);
    const after = await h.store.get({ repo: h.ref.repo, number: h.ref.number, headSha: SHA_A });
    expect(after).toEqual(before);
    const last = h.reporter.events[h.reporter.events.length - 1];
    expect(last?.type).toBe("verdict");
  });

  it("escalates without seating a panel once the round cap is reached", async () => {
    const blocker = assignFingerprints([blockerDraft()])[0] as Finding;
    const h = makeHarness({ policy: basePolicy({ rounds: { max: 1 } }), change: tier1Change({ headSha: SHA_B }) });
    h.store.seed(round1([blocker]));
    const r = await h.gate.review(h.ref);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.workspace.acquired).toBe(0);
    expect(r.verdict.decision).toBe("block");
    expect(r.verdict.escalated).toBe(true);
    expect(r.verdict.carried).toEqual([blocker.id]);
    expect(h.escalation.requests).toHaveLength(1);
    expect(h.reporter.types()).toEqual(["pending", "escalated"]);
    const stored = await h.store.get({ repo: h.ref.repo, number: h.ref.number, headSha: SHA_B });
    expect(stored?.verdict.escalated).toBe(true);
  });

  it("reports the verdict at the cap when there is no escalation port", async () => {
    const h = makeHarness({
      policy: basePolicy({ rounds: { max: 1 } }),
      change: tier1Change({ headSha: SHA_B }),
      deps: { escalation: undefined },
    });
    h.store.seed(round1([], "pass"));
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(h.reporter.types()).toEqual(["pending", "verdict"]);
  });
});

describe("createGate: robustness", () => {
  it("rejects with head-moved after reporting an error when the head moved", async () => {
    const h = makeHarness({ policy: basePolicy(), change: tier1Change({ headSha: SHA_B }) });
    const err = await h.gate.review(h.ref, { headSha: SHA_A }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).code).toBe("head-moved");
    expect(h.reporter.types()).toEqual(["error"]);
    expect(h.provider.calls).toHaveLength(0);
  });

  it("maps a seating failure to GateError(seating) after reporting an error", async () => {
    const policy = basePolicy({ models: { hunters: { connection: "nope", model: "x" } } });
    const h = makeHarness({ policy });
    const err = await h.gate.review(h.ref).catch((e: unknown) => e);
    expect((err as GateError).code).toBe("seating");
    expect((err as GateError).fix).toBeDefined();
    expect(h.reporter.types()).toEqual(["pending", "error"]);
  });

  it("retries a CAS conflict once, then fails with store-conflict", async () => {
    const h = makeHarness({ policy: basePolicy() });
    h.store.conflicts = 1;
    const ok = await h.gate.review(h.ref);
    expect(ok.verdict.decision).toBe("pass");
    expect(h.store.puts).toBe(2);

    const h2 = makeHarness({ policy: basePolicy() });
    h2.store.conflicts = 2;
    const err = await h2.gate.review(h2.ref).catch((e: unknown) => e);
    expect((err as GateError).code).toBe("store-conflict");
    expect(h2.reporter.types()).toEqual(["pending", "error"]);
  });

  it("never puts a secret into a GateError or error event", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      deps: {
        store: {
          get: async () => null,
          put: async () => ({ ok: true, version: "1" }),
          listForChange: async () => {
            throw new Error(`db auth failed for ${API_KEY}`);
          },
        },
      },
    });
    const err = await h.gate.review(h.ref).catch((e: unknown) => e);
    expect((err as GateError).code).toBe("internal");
    expect((err as GateError).message).not.toContain(API_KEY);
    expect(JSON.stringify(h.reporter.events)).not.toContain(API_KEY);
  });
});

describe("createGate: human verdicts, explain, estimate", () => {
  it("lets a human verdict replace a machine block", async () => {
    const draft = blockerDraft();
    const script = hunterThenJudge(
      (call) =>
        call.seat.lens === "correctness"
          ? { output: { verdict: "block", summary: "x", findings: [draft] } }
          : { output: passOutput() },
      judgeVotes(() => "confirm"),
    );
    const h = makeHarness({ policy: basePolicy(), script });
    const machine = await h.gate.review(h.ref);
    expect(machine.verdict.decision).toBe("block");
    const human = await h.gate.recordHumanVerdict({
      ref: h.ref,
      headSha: SHA_A,
      decision: "pass",
      signedBy: { kind: "human", login: "lead" },
      reason: "Accepted risk: guarded upstream.",
    });
    expect(human.kind).toBe("human");
    expect(human.decision).toBe("pass");
    expect(human.tier.level).toBe(machine.verdict.tier.level);
    expect(human.round).toBe(1);
    expect(human.findings).toEqual([]);
    const stored = await h.store.get({ repo: h.ref.repo, number: h.ref.number, headSha: SHA_A });
    expect(stored?.verdict.kind).toBe("human");
    const last = h.reporter.events[h.reporter.events.length - 1];
    expect(last?.type === "verdict" && last.verdict.kind).toBe("human");

    const explained = await h.gate.explain(h.ref);
    expect(explained.verdict?.kind).toBe("human");
    expect(explained.digest?.markdown).toMatch(/Signed by/);
    expect(explained.history).toHaveLength(1);

    // A later machine run on the same SHA keeps the human verdict.
    const again = await h.gate.review(h.ref);
    expect(again.verdict.kind).toBe("human");
  });

  it("human block carries the open findings", async () => {
    const blocker = assignFingerprints([blockerDraft()])[0] as Finding;
    const h = makeHarness({ policy: basePolicy() });
    h.store.seed(makeVerdict({ headSha: SHA_A, decision: "block", findings: [blocker], round: 2 }));
    const v = await h.gate.recordHumanVerdict({
      ref: h.ref,
      headSha: SHA_A,
      decision: "block",
      signedBy: { kind: "human", login: "lead" },
      reason: "no",
    });
    expect(v.findings.map((f) => f.id)).toEqual([blocker.id]);
    expect(v.round).toBe(2);
  });

  it("estimates tier, seats and cost without calling a model or reporting", async () => {
    const h = makeHarness({ policy: basePolicy(), change: tier3Change() });
    const est = await h.gate.estimate(h.ref);
    expect(est.tier.level).toBe(3);
    expect(est.seats.map((s) => s.id)).toEqual(["hunter:correctness:1", "hunter:security:1", "judge:1", "judge:2"]);
    expect(est.secondJudgeRound).toBe(true);
    expect(est.estimateUsd).toBeGreaterThan(0);
    expect(est.unknownSeats).toEqual([]);
    expect(est.summary).toMatch(/Panel: 2 hunters, 2 judges/);
    expect(est.summary).toMatch(/Estimated cost: \$/);
    expect(est.ceilings.some((c) => c.ceiling === "per-change")).toBe(true);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.provider.runners).toHaveLength(0);
    expect(h.reporter.events).toHaveLength(0);
    expect(h.workspace.acquired).toBe(0);

    const docs = await h.gate.estimate(docsChange());
    expect(docs.seats).toEqual([]);
    expect(docs.triage.decision).toBe("auto-pass");
    expect(docs.summary).toMatch(/auto-pass/);
  });
});
