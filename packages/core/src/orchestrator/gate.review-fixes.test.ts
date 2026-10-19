/** Tests for the PR #12 review findings (pending guard, workspace pin, persist, spend, escalation, fallback, timeouts). */
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  BACKUP,
  CATALOG,
  docsChange,
  HangingReporter,
  MAIN,
  makeHarness,
  passOutput,
  type Script,
  SHA_A,
  SHA_B,
  tier1Change,
  tier3Change,
} from "../../test/orchestrator/fakes.js";
import { assignFingerprints, fingerprintFinding } from "../stages/fingerprint.js";
import { makeFinding, makePolicy, makeVerdict } from "../stages/test-helpers.js";
import type { Finding, JudgeDecision, ReviewerInput, Verdict } from "../types.js";
import type { GateError } from "./errors.js";

const SHA_C = "c".repeat(40);
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
const X = blockerDraft();
const X_ID = fingerprintFinding(X);

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
const blockOnX: Script = hunterThenJudge(
  (call) =>
    call.seat.lens === "correctness"
      ? { output: { verdict: "block", summary: "x", findings: [X] } }
      : { output: passOutput() },
  judgeVotes(() => "confirm"),
);
const outage: Script = () => ({ status: "error", output: null, error: "upstream 503" });

const keyFor = (h: ReturnType<typeof makeHarness>, headSha: string) => ({
  repo: h.ref.repo,
  number: h.ref.number,
  headSha,
});
const reviewedVerdict = (extra: Partial<Verdict>): Verdict =>
  makeVerdict({
    seats: [
      {
        seat: {
          id: "hunter:correctness:1",
          lens: "correctness",
          role: "hunter",
          model: { connectionId: "main", provider: "anthropic", name: "sonnet-x" },
          budget: { maxTurns: 50, deadlineMs: 60_000 },
        },
        headSha: extra.headSha ?? SHA_A,
        round: extra.round ?? 1,
        output: passOutput(),
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
    ...extra,
  });

describe("blocker: a pending run never replaces a decided verdict for the same SHA", () => {
  it("block -> pass -> outage re-run -> push: the pass and its addressed findings survive", async () => {
    const h = makeHarness({ policy: basePolicy(), script: blockOnX });
    const a = await h.gate.review(h.ref);
    expect(a.verdict.decision).toBe("block");

    h.source.change = { ...h.source.change, headSha: SHA_B };
    h.provider.script = () => ({ output: passOutput({ addressed: [X_ID] }) });
    const b = await h.gate.review(h.ref);
    expect(b.verdict.decision).toBe("pass");
    expect(b.verdict.addressed).toEqual([X_ID]);
    const storedB = await h.store.get(keyFor(h, SHA_B));

    h.provider.script = outage;
    h.reporter.events.length = 0;
    const requestsBefore = h.escalation.requests.length;
    const re = await h.gate.review(h.ref);
    expect(re.verdict.decision).toBe("pass");
    expect(re.verdict.round).toBe(2);
    expect(re.pendingReason).toMatch(/reviewer seats failed/);
    expect(await h.store.get(keyFor(h, SHA_B))).toEqual(storedB);
    expect(h.reporter.types()).toEqual(["pending", "error", "verdict"]);
    const last = h.reporter.events[2];
    expect(last?.type === "verdict" && last.verdict.decision).toBe("pass");
    expect(h.escalation.requests.length).toBe(requestsBefore);

    h.source.change = { ...h.source.change, headSha: SHA_C };
    h.provider.script = () => ({ output: passOutput() });
    const c = await h.gate.review(h.ref);
    expect(c.verdict.decision).toBe("pass");
    expect(c.verdict.findings).toEqual([]);
    expect(c.verdict.carried ?? []).toEqual([]);
  });

  it("a budget refusal over a stored pass keeps and re-reports the pass", async () => {
    const policy = basePolicy({ budget: { windowUsd: 1 } });
    const h = makeHarness({ policy, deps: { estimateUsage: () => ({ in: 100_000, out: 10_000 }) } });
    h.store.seed(reviewedVerdict({ headSha: SHA_A, decision: "pass", round: 1 }));
    const before = await h.store.get(keyFor(h, SHA_A));
    await h.ledger.append({
      at: new Date(h.clock.now().getTime() - 1000).toISOString(),
      repo: h.ref.repo,
      number: 99,
      headSha: SHA_B,
      round: 1,
      seatId: "s",
      lens: "correctness",
      connectionId: "main",
      provider: "anthropic",
      model: "sonnet-x",
      tokens: { in: 1, out: 1 },
      usd: 5,
      estimated: false,
      installationId: "inst-1",
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(r.pendingReason).toMatch(/budget\.windowUsd/);
    expect(h.reporter.types()).toEqual(["pending", "budget-blocked", "verdict"]);
    expect(await h.store.get(keyFor(h, SHA_A))).toEqual(before);
  });
});

describe("I1: workspace pin", () => {
  it("fails seats whose workspace checked out another commit", async () => {
    const h = makeHarness({ policy: basePolicy() });
    h.workspace.handleOverride = { headSha: SHA_B };
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.seats.every((s) => s.status === "error" && /not the pinned head/.test(s.error ?? ""))).toBe(true);
    expect(r.verdict.quorum.passed).toBe(0);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.workspace.disposed).toBe(h.workspace.acquired);
  });

  it("fails seats on a dirty workspace in PR mode", async () => {
    const h = makeHarness({ policy: basePolicy() });
    h.workspace.handleOverride = { dirty: true };
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.seats[0]?.error).toMatch(/uncommitted changes/);
  });

  it("allows a dirty tree in local mode and only stores it under WORKTREE", async () => {
    const h = makeHarness({ policy: basePolicy() });
    h.workspace.handleOverride = { headSha: "WORKTREE", dirty: true };
    const local = await h.gate.reviewChange(tier1Change(), { diff: "+x" });
    expect(local.verdict.decision).toBe("pass");
    expect(h.store.puts).toBe(0);

    const pinned = await h.gate.reviewChange(tier1Change(), { diff: "+x" }, { persist: true });
    expect(pinned.verdict.decision).toBe("pending");
    expect(pinned.verdict.seats[0]?.error).toMatch(/dirty working tree cannot be stored/);
    // Stored as pending (never a pass) under the real SHA.
    expect((await h.store.get(keyFor(h, SHA_A)))?.verdict.decision).toBe("pending");

    const worktree = await h.gate.reviewChange(tier1Change({ headSha: "WORKTREE" }), { diff: "+x" }, { persist: true });
    expect(worktree.verdict.decision).toBe("pass");
    expect((await h.store.get(keyFor(h, "WORKTREE")))?.verdict.decision).toBe("pass");
  });
});

describe("I2: reviewChange persist option", () => {
  it("by default writes nothing and never escalates, but still reports", async () => {
    const h = makeHarness({ policy: basePolicy(), script: outage });
    for (let i = 0; i < 3; i++) {
      const r = await h.gate.reviewChange(tier1Change(), { diff: "+x" });
      expect(r.verdict.decision).toBe("pending");
      expect(r.verdict.round).toBe(1);
    }
    expect(h.store.puts).toBe(0);
    expect(h.escalation.requests).toHaveLength(0);
    expect(h.reporter.types().filter((t) => t === "verdict")).toHaveLength(3);
    expect(h.ledger.rows.length).toBeGreaterThan(0);
  });

  it("persist: true stores like review()", async () => {
    const h = makeHarness({ policy: basePolicy() });
    await h.gate.reviewChange(tier1Change(), { diff: "+x" }, { persist: true });
    expect((await h.store.get(keyFor(h, SHA_A)))?.verdict.decision).toBe("pass");
  });
});

describe("I3: per-change spend from prior verdicts", () => {
  it("without a ledger, counts cost.usd of earlier rounds", async () => {
    const h = makeHarness({ policy: basePolicy({ budget: { perChangeUsd: 1 } }), deps: { ledger: undefined } });
    h.source.change = { ...h.source.change, headSha: SHA_B };
    h.store.seed(
      reviewedVerdict({ headSha: SHA_A, decision: "pass", cost: { usd: 50, tokens: { in: 0, out: 0 }, bySeat: {} } }),
    );
    const r = await h.gate.review(h.ref);
    expect(h.reporter.types()).toEqual(["pending", "budget-blocked"]);
    expect(r.verdict.reason).toMatch(/per-change/);
    expect(h.provider.calls).toHaveLength(0);
  });

  it("with a ledger, takes the larger of the ledger and the verdict sum", async () => {
    const h = makeHarness({ policy: basePolicy({ budget: { perChangeUsd: 1 } }) });
    h.source.change = { ...h.source.change, headSha: SHA_B };
    h.store.seed(
      reviewedVerdict({ headSha: SHA_A, decision: "pass", cost: { usd: 50, tokens: { in: 0, out: 0 }, bySeat: {} } }),
    );
    await h.gate.review(h.ref);
    expect(h.reporter.types()).toEqual(["pending", "budget-blocked"]);
  });
});

describe("I4: escalation idempotency", () => {
  it("escalates a pending SHA once across re-runs, recording the handle", async () => {
    const h = makeHarness({ policy: basePolicy(), script: outage });
    const first = await h.gate.review(h.ref);
    expect(first.verdict.escalated).toBe(true);
    expect(first.verdict.escalation?.id).toBe("esc-1");
    expect((await h.store.get(keyFor(h, SHA_A)))?.verdict.escalation?.id).toBe("esc-1");
    const second = await h.gate.review(h.ref);
    const third = await h.gate.review(h.ref);
    expect(h.escalation.requests).toHaveLength(1);
    expect(second.verdict.escalated).toBe(true);
    expect(third.verdict.escalation?.id).toBe("esc-1");
  });

  it("escalates a capped SHA once across re-runs", async () => {
    const blocker = assignFingerprints([X])[0] as Finding;
    const h = makeHarness({ policy: basePolicy({ rounds: { max: 1 } }), change: tier1Change({ headSha: SHA_B }) });
    h.store.seed(reviewedVerdict({ headSha: SHA_A, decision: "block", findings: [blocker] }));
    await h.gate.review(h.ref);
    await h.gate.review(h.ref);
    await h.gate.review(h.ref);
    expect(h.escalation.requests).toHaveLength(1);
  });

  it("does not mark escalated when request throws or there is no port", async () => {
    const h = makeHarness({ policy: basePolicy(), script: outage });
    h.escalation.mode = "throw";
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.escalated).toBeUndefined();
    expect(r.escalation).toBeUndefined();
    expect(h.reporter.types()).not.toContain("escalated");
    expect((await h.store.get(keyFor(h, SHA_A)))?.verdict.escalated).toBeUndefined();

    const blocker = assignFingerprints([X])[0] as Finding;
    const h2 = makeHarness({
      policy: basePolicy({ rounds: { max: 1 } }),
      change: tier1Change({ headSha: SHA_B }),
      deps: { escalation: undefined },
    });
    h2.store.seed(reviewedVerdict({ headSha: SHA_A, decision: "block", findings: [blocker] }));
    const capped = await h2.gate.review(h2.ref);
    expect(capped.verdict.escalated).toBeUndefined();
  });
});

describe("I5: fallback budget", () => {
  const fallbackPolicy = (budget: Record<string, number>, model = "gpt-x") =>
    basePolicy({
      models: { decorrelate: false, fallback: { connection: "backup", model } },
      budget,
    });

  it("gives the fallback only what remains of the per-seat budget", async () => {
    const h = makeHarness({
      policy: fallbackPolicy({ perSeatUsd: 1 }),
      connections: [MAIN, BACKUP],
      script: () => ({ status: "error", output: null, usage: [{ tokens: { in: 1, out: 1 }, usd: 0.4 }] }),
      backupScript: () => ({ output: passOutput() }),
      deps: { estimateUsage: () => ({ in: 10_000, out: 1_000 }) },
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(h.backupProvider.calls).toHaveLength(2);
    for (const c of h.backupProvider.calls) expect(c.seat.budget.maxUsd).toBeCloseTo(0.6, 10);
    expect(r.verdict.seats[0]?.seat.budget.maxUsd).toBe(1);
  });

  it("skips the fallback when the per-seat budget is spent", async () => {
    const h = makeHarness({
      policy: fallbackPolicy({ perSeatUsd: 1 }),
      connections: [MAIN, BACKUP],
      script: () => ({ status: "error", output: null, usage: [{ tokens: { in: 1, out: 1 }, usd: 1 }] }),
      backupScript: () => ({ output: passOutput() }),
      deps: { estimateUsage: () => ({ in: 10_000, out: 1_000 }) },
    });
    const r = await h.gate.review(h.ref);
    expect(h.backupProvider.calls).toHaveLength(0);
    expect(r.verdict.decision).toBe("pending");
  });

  it("skips a fallback whose estimate would breach budget.perChangeUsd", async () => {
    const h = makeHarness({
      policy: fallbackPolicy({ perChangeUsd: 2 }, "gpt-big"),
      connections: [MAIN, BACKUP],
      script: () => ({ status: "error", output: null }),
      backupScript: () => ({ output: passOutput() }),
      deps: { estimateUsage: () => ({ in: 100_000, out: 10_000 }) },
    });
    const r = await h.gate.review(h.ref);
    expect(h.backupProvider.calls).toHaveLength(0);
    expect(r.verdict.decision).toBe("pending");
  });

  it("survives a catalog that throws while planning the fallback, keeping the first attempt's cost", async () => {
    const h = makeHarness({
      policy: fallbackPolicy({}),
      connections: [MAIN, BACKUP],
      script: () => ({ status: "error", output: null, usage: [{ tokens: { in: 1, out: 1 }, usd: 0.25 }] }),
      deps: {
        catalog: (id) => {
          if (id === "backup") throw new Error("catalog down");
          return CATALOG[id] ?? [];
        },
      },
    });
    const r = await h.gate.review(h.ref);
    // An empty catalog is trusted by planFallback, so each seat tried both connections; every attempt is charged.
    expect(h.backupProvider.calls).toHaveLength(2);
    expect(r.verdict.cost.usd).toBeCloseTo(1, 10);
    expect(r.verdict.decision).toBe("pending");
  });
});

describe("I6: port timeouts", () => {
  const fast = { ledgerAppendMs: 50, reporterMs: 50, escalationMs: 50, storeMs: 50, workspaceAcquireMs: 50 };

  it("a hanging ledger append does not hold the review", async () => {
    const h = makeHarness({ policy: basePolicy(), deps: { timeouts: fast } });
    h.ledger.hangAppend = true;
    const started = Date.now();
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a hanging reporter is abandoned", async () => {
    const hanging = new HangingReporter();
    const h = makeHarness({ policy: basePolicy(), deps: { timeouts: fast } });
    const { createGate } = await import("./gate.js");
    const r = await createGate({ ...h.deps, reporters: [hanging, h.reporter] }).review(h.ref);
    expect(r.verdict.decision).toBe("pass");
    expect(hanging.calls).toBe(2);
  });

  it("a hanging escalation is treated as failed", async () => {
    const h = makeHarness({ policy: basePolicy(), script: outage, deps: { timeouts: fast } });
    h.escalation.mode = "hang";
    const r = await h.gate.review(h.ref);
    expect(r.verdict.escalated).toBeUndefined();
    expect(h.reporter.types()).not.toContain("escalated");
  });

  it("a hanging store read fails the review with a clear internal error", async () => {
    const h = makeHarness({ policy: basePolicy(), deps: { timeouts: fast } });
    h.store.hangGet = true;
    const err = (await h.gate.review(h.ref).catch((e: unknown) => e)) as GateError;
    expect(err.code).toBe("internal");
    expect(err.message).toMatch(/verdict store read timed out/);
    expect(h.reporter.types()).toEqual(["pending", "error"]);
  });

  it("a hanging workspace acquire fails the seat, not the review", async () => {
    const h = makeHarness({ policy: basePolicy(), deps: { timeouts: fast } });
    h.workspace.hang = true;
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.seats[0]?.error).toMatch(/workspace unavailable: workspace acquire timed out/);
  });
});

describe("missing cases", () => {
  it("all hunters insufficient-work -> pending", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      script: () => ({ output: passOutput(), audit: { substantiveCalls: 0 } }),
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(r.verdict.seats.every((s) => s.status === "insufficient-work")).toBe(true);
  });

  it("all hunters schema-invalid -> pending with an error event", async () => {
    const h = makeHarness({ policy: basePolicy(), script: () => ({ status: "schema-invalid", output: null }) });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("pending");
    expect(h.reporter.types()).toContain("error");
  });

  it("a judge that throws leaves the block standing (unjudged)", async () => {
    const h = makeHarness({
      policy: basePolicy(),
      script: hunterThenJudge(
        (call) =>
          call.seat.lens === "correctness"
            ? { output: { verdict: "block", summary: "x", findings: [X] } }
            : { output: passOutput() },
        () => new Error("judge crashed"),
      ),
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.decision).toBe("block");
    expect(r.verdict.seats.find((s) => s.seat.role === "judge")?.status).toBe("error");
    expect(r.verdict.reason).toMatch(/unjudged/);
  });

  it("a concurrent block stored during the put makes a pass contested", async () => {
    const h = makeHarness({ policy: basePolicy() });
    const blocker = assignFingerprints([X])[0] as Finding;
    h.store.beforePut = () => {
      h.store.beforePut = undefined;
      h.store.seed(reviewedVerdict({ headSha: SHA_A, decision: "block", round: 1, findings: [blocker] }));
    };
    const r = await h.gate.review(h.ref);
    expect(r.contested).toBe(true);
    expect(r.verdict.decision).toBe("block");
    expect((await h.store.get(keyFor(h, SHA_A)))?.verdict.decision).toBe("block");
  });

  it("second judge round where one judge fails keeps that judge's first vote", async () => {
    const f1 = blockerDraft({ title: "Crash one", line: 5 });
    const f2 = blockerDraft({ title: "Crash two", class: "race", severity: "important", line: 40 });
    const [id1, id2] = assignFingerprints([f1, f2]).map((f) => f.id);
    const h = makeHarness({
      policy: basePolicy(),
      change: tier3Change(),
      script: hunterThenJudge(
        (call) =>
          call.seat.lens === "correctness"
            ? { output: { verdict: "block", summary: "x", findings: [f1, f2] } }
            : { output: passOutput() },
        (call) => {
          const second = (call.input.candidateFindings ?? []).length === 1;
          if (second && call.seat.id === "judge:2") return new Error("judge 2 down");
          return judgeVotes((f, _i, seatId) =>
            !second && seatId === "judge:2" && f.id === id2 ? "refute" : "confirm",
          )(call);
        },
      ),
    });
    const r = await h.gate.review(h.ref);
    expect(h.provider.calls.filter((c) => c.seat.role === "judge")).toHaveLength(4);
    expect(r.verdict.findings.map((f) => f.id)).toEqual([id1]);
    expect(r.verdict.seats.filter((s) => s.seat.role === "judge").every((s) => s.status === "ok")).toBe(true);
  });
});

describe("estimate parity and limits", () => {
  it("runs the same admission and ladder as review", async () => {
    const policy = basePolicy({
      models: { hunters: { connection: "main", model: "opus-x" }, judges: { connection: "main", model: "opus-x" } },
      budget: { perChangeUsd: 4 },
    });
    const h = makeHarness({ policy, deps: { estimateUsage: () => ({ in: 100_000, out: 10_000 }) } });
    const est = await h.gate.estimate(h.ref);
    expect(est.downgrades?.map((d) => d.step)).toEqual(["hunters-model"]);
    expect(est.seats.filter((s) => s.role === "hunter").map((s) => s.model.name)).toEqual(["sonnet-x", "sonnet-x"]);
    expect(est.budgetBlocked).toBeUndefined();
    expect(est.summary).toMatch(/Downgrade: hunters-model/);
    const r = await h.gate.review(h.ref);
    expect(r.verdict.downgrades?.map((d) => d.step)).toEqual(["hunters-model"]);
  });

  it("reports a budget refusal like review would", async () => {
    const h = makeHarness({ policy: basePolicy({ budget: { spendLimitUsd: 10 } }), deps: { ledger: undefined } });
    const est = await h.gate.estimate(h.ref);
    expect(est.budgetBlocked?.ceiling).toBe("all-time");
  });

  it("throws GateError(seating) for an unreachable model or a throwing catalog", async () => {
    const h = makeHarness({ policy: basePolicy({ models: { hunters: { connection: "main", model: "nope-9" } } }) });
    await expect(h.gate.estimate(h.ref)).rejects.toMatchObject({ code: "seating" });
    const h2 = makeHarness({
      policy: basePolicy(),
      deps: {
        catalog: () => {
          throw new Error("registry down");
        },
      },
    });
    await expect(h2.gate.estimate(h2.ref)).rejects.toMatchObject({ code: "seating" });
  });

  it("flags seats whose model cannot hold the diff and sizes from the real diff", async () => {
    const tiny = (CATALOG.main ?? []).map((m) => ({ ...m, contextTokens: 8_000 }));
    const h = makeHarness({
      policy: basePolicy(),
      diffs: { full: "+".repeat(40_000) },
      deps: { catalog: (id) => (id === "main" ? tiny : []) },
    });
    const est = await h.gate.estimate(h.ref);
    expect(est.unknownSeats.sort()).toEqual(["hunter:correctness:1", "hunter:repro:1", "judge:1"]);
    expect(est.summary).toMatch(/estimate unreliable/);
    const small = makeHarness({ policy: basePolicy(), diffs: { full: "+x" } });
    expect((await small.gate.estimate(small.ref)).unknownSeats).toEqual([]);
  });

  it("estimates nothing for a triaged change", async () => {
    const h = makeHarness({ policy: basePolicy(), change: docsChange() });
    const est = await h.gate.estimate(h.ref);
    expect(est.seats).toEqual([]);
    expect(JSON.stringify(est)).not.toContain(API_KEY);
  });
});
