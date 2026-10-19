import { describe, expect, it } from "vitest";
import { loadPolicy } from "../policy/index.js";
import type { ModelRef, ModelTierClass, Seat } from "../types.js";
import {
  AlertLatch,
  admit,
  CEILING_POLICY_KEYS,
  ceilingEvaluator,
  classifyRunnerExit,
  DEFAULT_LENS_PRIORITY,
  downgradeLadder,
  estimatePanel,
  evaluateCeilings,
  seatBudgetFromPolicy,
} from "./index.js";

const base = loadPolicy({});

describe("evaluateCeilings", () => {
  it("projects per-change as spent so far plus the panel estimate", () => {
    const r = evaluateCeilings({
      policy: base,
      seatEstimates: [
        { seatId: "a", usd: 3 },
        { seatId: "b", usd: 4 },
      ],
      changeSpendUsd: 20,
    });
    const pc = r.find((x) => x.ceiling === "per-change");
    expect(pc).toMatchObject({ limitUsd: 25, currentUsd: 20, projectedUsd: 27, breached: true });
    expect(pc?.fraction).toBeCloseTo(27 / 25);
    const seats = r.filter((x) => x.ceiling === "per-seat");
    expect(seats.map((s) => s.seatId)).toEqual(["a", "b"]);
    expect(seats.every((s) => !s.breached)).toBe(true);
  });

  it("null (unset) and 0 (disabled) never breach", () => {
    const policy = loadPolicy({ budget: { perChangeUsd: 0, perSeatUsd: 0, windowUsd: null } });
    const r = evaluateCeilings({
      policy,
      seatEstimates: [{ seatId: "a", usd: 1000 }],
      changeSpendUsd: 1e6,
      windowSpendUsd: 1e6,
      allTimeSpendUsd: 1e6,
      monthlySpendUsd: 1e6,
    });
    expect(r.every((x) => !x.breached && x.limitUsd === null && x.fraction === 0)).toBe(true);
  });

  it("installation ceilings use their own spend", () => {
    const policy = loadPolicy({ budget: { windowUsd: 100, spendLimitUsd: 1000, perInstallationMonthlyUsd: 500 } });
    const r = evaluateCeilings({
      policy,
      seatEstimates: [{ seatId: "a", usd: 2 }],
      changeSpendUsd: 0,
      windowSpendUsd: 99,
      allTimeSpendUsd: 10,
      monthlySpendUsd: 499,
    });
    expect(r.find((x) => x.ceiling === "window")?.breached).toBe(true);
    expect(r.find((x) => x.ceiling === "all-time")?.breached).toBe(false);
    expect(r.find((x) => x.ceiling === "monthly")?.projectedUsd).toBe(501);
  });

  it("a zero-cost panel never trips a ceiling spend already sits on", () => {
    const r = evaluateCeilings({ policy: base, seatEstimates: [{ seatId: "a", usd: 0 }], changeSpendUsd: 25 });
    expect(r.find((x) => x.ceiling === "per-change")?.breached).toBe(false);
  });

  it("flags a per-seat breach", () => {
    const r = evaluateCeilings({ policy: base, seatEstimates: [{ seatId: "judge:1", usd: 6 }], changeSpendUsd: 0 });
    expect(r.find((x) => x.ceiling === "per-seat")).toMatchObject({ breached: true, seatId: "judge:1" });
  });
});

describe("evaluateCeilings: fail closed and advisory", () => {
  const policy = loadPolicy({ budget: { windowUsd: 100, spendLimitUsd: 1000, perInstallationMonthlyUsd: 500 } });

  it("marks configured ceilings with missing spend as unknownSpend and breached", () => {
    const r = evaluateCeilings({ policy, seatEstimates: [{ seatId: "a", usd: 1 }], changeSpendUsd: 0 });
    for (const c of ["window", "all-time", "monthly"] as const) {
      expect(r.find((x) => x.ceiling === c)).toMatchObject({ unknownSpend: true, breached: true });
    }
  });

  it("unset ceilings with missing spend are fine", () => {
    const r = evaluateCeilings({ policy: base, seatEstimates: [], changeSpendUsd: 0 });
    expect(r.some((x) => x.unknownSpend)).toBe(false);
    expect(admit({ policy: base, seatEstimates: [], changeSpendUsd: 0 }).ok).toBe(true);
  });

  it("admit fails closed with a ledger-required message", () => {
    const r = admit({
      policy,
      seatEstimates: [{ seatId: "a", usd: 1 }],
      changeSpendUsd: 0,
      allTimeSpendUsd: 0,
      monthlySpendUsd: 0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.binding.ceiling).toBe("window");
    expect(r.message).toContain("spend for window unknown; ledger required");
  });

  it("advisory ceilings never block but are reported", () => {
    const r = admit({
      policy,
      seatEstimates: [{ seatId: "a", usd: 2 }],
      changeSpendUsd: 0,
      windowSpendUsd: 0,
      allTimeSpendUsd: 0,
      monthlySpendUsd: 499,
      advisory: ["monthly"],
    });
    expect(r.ok).toBe(true);
    expect(r.advisoryBreaches.map((x) => x.ceiling)).toEqual(["monthly"]);
    expect(r.results.find((x) => x.ceiling === "monthly")).toMatchObject({ breached: true, advisory: true });
    // Advisory also covers unknown spend (the Action has no monthly ledger).
    const r2 = admit({
      policy,
      seatEstimates: [],
      changeSpendUsd: 0,
      windowSpendUsd: 0,
      allTimeSpendUsd: 0,
      advisory: ["monthly"],
    });
    expect(r2.ok).toBe(true);
  });
});

describe("admit", () => {
  it("admits when nothing breaches", () => {
    const r = admit({ policy: base, seatEstimates: [{ seatId: "a", usd: 1 }], changeSpendUsd: 0 });
    expect(r.ok).toBe(true);
  });

  it("names the binding ceiling and the policy key to raise", () => {
    const r = admit({ policy: base, seatEstimates: [{ seatId: "a", usd: 4 }], changeSpendUsd: 24 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.binding.ceiling).toBe("per-change");
    expect(r.message).toContain('"per-change"');
    expect(r.message).toContain(CEILING_POLICY_KEYS["per-change"]);
    expect(r.message).toContain("$28.00");
  });

  it("prefers installation-wide ceilings as binding", () => {
    const policy = loadPolicy({ budget: { spendLimitUsd: 10 } });
    const r = admit({ policy, seatEstimates: [{ seatId: "a", usd: 4 }], changeSpendUsd: 24, allTimeSpendUsd: 9 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.binding.ceiling).toBe("all-time");
    expect(r.message).toContain("budget.spendLimitUsd");
    expect(r.message).toContain("reset");
  });
});

describe("AlertLatch", () => {
  it("fires once per crossing", () => {
    const l = new AlertLatch([0.5, 0.8, 1]);
    expect(l.observe("per-change", 0.4)).toEqual([]);
    expect(l.observe("per-change", 0.85).map((e) => e.threshold)).toEqual([0.5, 0.8]);
    expect(l.observe("per-change", 0.9)).toEqual([]);
    expect(l.observe("per-change", 1.01).map((e) => e.threshold)).toEqual([1]);
    expect(l.observe("per-change", 1.01)).toEqual([]);
  });

  it("re-arms only after dropping below the threshold", () => {
    const l = new AlertLatch([0.5, 1]);
    l.observe("window", 1.2);
    expect(l.observe("window", 0.7)).toEqual([]); // dropped below 1 → 1 re-arms, 0.5 still latched
    expect(l.observe("window", 1.05).map((e) => e.threshold)).toEqual([1]);
    expect(l.observe("window", 0.1)).toEqual([]);
    expect(l.observe("window", 0.6).map((e) => e.threshold)).toEqual([0.5]);
  });

  it("tracks ceilings independently", () => {
    const l = new AlertLatch([0.5]);
    expect(l.observe("a", 0.6)).toHaveLength(1);
    expect(l.observe("b", 0.6)).toHaveLength(1);
  });

  it("ignores a threshold of 0", () => {
    const l = new AlertLatch([0, 0.5]);
    expect(l.observe("per-change", 0)).toEqual([]);
    expect(l.toJSON().thresholds).toEqual([0.5]);
  });

  it("observeResults skips unset/disabled ceilings and keys per-seat by seat", () => {
    const l = new AlertLatch([0.5]);
    const results = evaluateCeilings({
      policy: loadPolicy({ budget: { perChangeUsd: 0 } }),
      seatEstimates: [{ seatId: "judge:1", usd: 4 }],
      changeSpendUsd: 1e6,
    });
    const ev = l.observeResults(results);
    expect(ev.map((e) => e.ceiling)).toEqual(["per-seat:judge:1"]);
  });

  it("round-trips through JSON", () => {
    const l = new AlertLatch([0.5, 0.8]);
    l.observe("all-time", 0.9);
    const restored = AlertLatch.fromJSON(JSON.parse(JSON.stringify(l)));
    expect(restored.observe("all-time", 0.95)).toEqual([]);
    expect(restored.toJSON()).toEqual(l.toJSON());
  });

  it("tolerates malformed state and drops unknown thresholds", () => {
    expect(AlertLatch.fromJSON("garbage", [0.5]).observe("x", 0.6)).toHaveLength(1);
    const l = new AlertLatch([0.5, 0.8]);
    l.observe("x", 0.9);
    const r = AlertLatch.fromJSON(l.toJSON(), [0.8, 1]);
    expect(r.toJSON().fired).toEqual({ x: [0.8] });
  });
});

// --- ladder fixtures --------------------------------------------------------------------------------------------

const LADDER: Record<string, { cheaper?: string; tier: ModelTierClass; usd: number }> = {
  opus: { cheaper: "sonnet", tier: "frontier", usd: 4 },
  sonnet: { cheaper: "haiku", tier: "mid", usd: 2 },
  haiku: { tier: "small", usd: 0.5 },
};
const ref = (name: string): ModelRef => ({ connectionId: "c", provider: "anthropic", name });
const budget = seatBudgetFromPolicy(base, "hunter");
const hunter = (lens: string, model = "sonnet"): Seat => ({
  id: `hunter:${lens}:1`,
  lens,
  role: "hunter",
  model: ref(model),
  budget,
});
const judge = (n: number, model = "opus"): Seat => ({
  id: `judge:${n}`,
  lens: "judge",
  role: "judge",
  model: ref(model),
  budget,
});
const cheaper = (m: ModelRef): ModelRef | undefined => {
  const c = LADDER[m.name]?.cheaper;
  return c ? ref(c) : undefined;
};
const estimate = (s: Seat): number | undefined => LADDER[s.model.name]?.usd;
const tierOf = (m: ModelRef): ModelTierClass | undefined => LADDER[m.name]?.tier;

describe("downgradeLadder", () => {
  const seats = [hunter("intent"), hunter("correctness"), hunter("repro"), hunter("security"), judge(1), judge(2)];
  // full cost: 4 hunters * 2 + 2 judges * 4 = 16
  const perChange = (limit: number, spent = 0) =>
    ceilingEvaluator(
      { policy: loadPolicy({ budget: { perChangeUsd: limit, perSeatUsd: 0 } }), changeSpendUsd: spent },
      estimate,
    );
  const go = (limit: number, extra: Partial<Parameters<typeof downgradeLadder>[0]> = {}, spent = 0) =>
    downgradeLadder({
      seats,
      policy: base,
      evaluate: perChange(limit, spent),
      cheaper,
      tierOf,
      quorumRequired: 2,
      ...extra,
    });

  it("returns unchanged when already within budget", () => {
    const r = go(16);
    expect(r.seats).toBe(seats);
    expect(r.steps).toEqual([]);
    expect(r.withinBudget).toBe(true);
  });

  it("steps hunters first and records downgradedFrom", () => {
    // hunters to haiku: 4*0.5 + 8 = 10
    const r = go(10);
    expect(r.withinBudget).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model"]);
    expect(r.steps[0]).toMatchObject({ from: "c/sonnet", to: "c/haiku" });
    expect(r.steps[0]?.reason).toContain("budget.perChangeUsd");
    const h = r.seats.filter((s) => s.role === "hunter");
    expect(h.every((s) => s.model.name === "haiku" && s.downgradedFrom?.name === "sonnet")).toBe(true);
    expect(r.seats.filter((s) => s.role === "judge").every((s) => s.downgradedFrom === undefined)).toBe(true);
  });

  it("steps judges after hunters, never below the hunters' tier", () => {
    const opusHunters = [hunter("intent", "opus"), hunter("correctness", "opus"), judge(1), judge(2)];
    // hunters opus->sonnet: 2*2 + 2*4 = 12; judges opus->sonnet allowed (mid >= mid): 8
    const r = downgradeLadder({
      seats: opusHunters,
      policy: base,
      evaluate: perChange(8),
      cheaper,
      tierOf,
      quorumRequired: 2,
    });
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model"]);
    expect(r.withinBudget).toBe(true);
    expect(r.seats.filter((s) => s.role === "judge").every((s) => s.model.name === "sonnet")).toBe(true);
  });

  it("refuses a judge step below the hunters, or to a model of unknown tier", () => {
    LADDER.stuck = { tier: "mid", usd: 2 };
    const stuck = [hunter("intent", "stuck"), judge(1, "sonnet")];
    const r = downgradeLadder({
      seats: stuck,
      policy: base,
      evaluate: perChange(1),
      cheaper,
      tierOf,
      quorumRequired: 1,
    });
    expect(r.seats.find((x) => x.role === "judge")?.model.name).toBe("sonnet");
    expect(r.steps.map((x) => x.step)).toEqual(["block"]);
    delete LADDER.stuck;
    const unknownTier = () => undefined;
    const r2 = downgradeLadder({
      seats: [hunter("a", "haiku"), judge(1)],
      policy: base,
      evaluate: perChange(1),
      cheaper,
      tierOf: unknownTier,
      quorumRequired: 1,
    });
    expect(r2.seats.find((x) => x.role === "judge")?.model.name).toBe("opus");
  });

  it("drops hunters to quorum using the default lens priority", () => {
    expect(DEFAULT_LENS_PRIORITY.slice(0, 3)).toEqual(["correctness", "security", "intent"]);
    // after hunters->haiku and judges->sonnet: 4*0.5 + 2*2 = 6; need <= 5 → drop 2 hunters (5)
    const r = go(5);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model", "seat-count"]);
    expect(r.withinBudget).toBe(true);
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["correctness", "security"]);
    expect(r.steps[2]).toMatchObject({ from: "4 hunters", to: "2 hunters" });
  });

  it("drops unlisted lenses before listed ones and honours an explicit priority", () => {
    const withCustom = [hunter("custom"), hunter("perf"), hunter("correctness"), judge(1, "haiku")];
    const r = downgradeLadder({
      seats: withCustom,
      policy: base,
      evaluate: perChange(1.6),
      cheaper,
      tierOf,
      quorumRequired: 2,
    });
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["perf", "correctness"]);
    const r2 = go(5, { lensPriority: ["repro", "intent"] });
    expect(r2.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["intent", "repro"]);
  });

  it("works against a per-seat ceiling, not just per-change", () => {
    // per-seat cap $3: opus judges ($4) breach; judges -> sonnet ($2) fixes it once hunters are at haiku.
    const evaluate = ceilingEvaluator(
      { policy: loadPolicy({ budget: { perSeatUsd: 3, perChangeUsd: 0 } }), changeSpendUsd: 0 },
      estimate,
    );
    const r = downgradeLadder({ seats, policy: base, evaluate, cheaper, tierOf, quorumRequired: 2 });
    expect(r.withinBudget).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model"]);
    expect(r.steps[0]?.reason).toContain("budget.perSeatUsd");
  });

  it("blocks naming the binding ceiling and its policy key, never onOverBudget", () => {
    const evaluate = ceilingEvaluator(
      {
        policy: loadPolicy({ budget: { windowUsd: 10 } }),
        changeSpendUsd: 0,
        windowSpendUsd: 9.9,
        allTimeSpendUsd: 0,
        monthlySpendUsd: 0,
      },
      estimate,
    );
    const r = downgradeLadder({ seats, policy: base, evaluate, cheaper, tierOf, quorumRequired: 2 });
    expect(r.withinBudget).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model", "seat-count", "block"]);
    const reason = r.steps.at(-1)?.reason ?? "";
    expect(reason).toContain('"window"');
    expect(reason).toContain("budget.windowUsd");
    expect(reason).not.toContain("onOverBudget");
    expect(r.seats.filter((s) => s.role === "hunter")).toHaveLength(2);
  });

  it("counts what was already spent on the change", () => {
    const r = go(25, {}, 24);
    expect(r.withinBudget).toBe(false);
    expect(r.steps.at(-1)?.reason).toContain("budget.perChangeUsd");
  });

  it("onOverBudget: block skips straight to block", () => {
    const r = go(10, { policy: loadPolicy({ budget: { onOverBudget: "block" } }) });
    expect(r.steps.map((s) => s.step)).toEqual(["block"]);
    expect(r.seats).toBe(seats);
  });

  it("a disabled limit is always within budget", () => {
    expect(go(0, {}, 1e9).withinBudget).toBe(true);
  });
});

describe("classifyRunnerExit", () => {
  const caps = { maxUsd: 5, maxTurns: 50, deadlineMs: 600_000 };
  const exit1 = { exitCode: 1, stderr: "", budgetFlagSet: true, caps, wallMs: 1000 };

  it("exit 0 is ok", () => {
    expect(classifyRunnerExit({ ...exit1, exitCode: 0 }).status).toBe("ok");
  });

  it("timedOut is timeout", () => {
    const r = classifyRunnerExit({ ...exit1, exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(r.status).toBe("timeout");
    expect(r.recovery).toContain("budget.seatDeadlineMs");
  });

  it("SIGKILL at 46/50 turns with empty stderr (OOM) is an error", () => {
    const r = classifyRunnerExit({ ...exit1, exitCode: null, signal: "SIGKILL", usage: { turns: 46 } });
    expect(r.status).toBe("error");
  });

  it("a signal is an error even with usage at the cap", () => {
    expect(classifyRunnerExit({ ...exit1, exitCode: null, signal: "SIGTERM", usage: { turns: 50 } }).status).toBe(
      "error",
    );
  });

  it("429 rate limit near the usd cap is an error", () => {
    const r = classifyRunnerExit({ ...exit1, stderr: "Error: 429 rate_limit_error", usage: { usd: 4.8 } });
    expect(r.status).toBe("error");
  });

  it("401 authentication failure near the usd cap is an error", () => {
    const r = classifyRunnerExit({ ...exit1, stderr: "AuthenticationError: 401", usage: { usd: 4.6 } });
    expect(r.status).toBe("error");
    expect(r.recovery).toBeUndefined();
  });

  it("usd at >= 95% of the cap with clean stderr is a budget pause", () => {
    const r = classifyRunnerExit({ ...exit1, usage: { usd: 4.8 } });
    expect(r.status).toBe("budget-exceeded");
    expect(r.recovery).toBe("Raise budget.perSeatUsd and re-run the check.");
    expect(classifyRunnerExit({ ...exit1, usage: { usd: 4.6 } }).status).toBe("error"); // 92%: not enough
  });

  it("turns at the cap names seatMaxTurns; 46/50 is not enough", () => {
    const r = classifyRunnerExit({ ...exit1, usage: { turns: 50 } });
    expect(r.status).toBe("budget-exceeded");
    expect(r.recovery).toContain("budget.seatMaxTurns");
    expect(classifyRunnerExit({ ...exit1, usage: { turns: 46 } }).status).toBe("error");
  });

  it("an explicit budget subtype counts as evidence", () => {
    const r = classifyRunnerExit({ ...exit1, budgetSubtype: "error_max_turns" });
    expect(r.status).toBe("budget-exceeded");
    expect(r.recovery).toContain("seatMaxTurns");
    expect(classifyRunnerExit({ ...exit1, budgetSubtype: "error_max_budget_usd" }).recovery).toContain("perSeatUsd");
  });

  it("stack traces (CJS, ESM file:// and absolute frames) mean a crash", () => {
    for (const stderr of [
      "    at run (/app/runner.js:10:5)",
      "    at file:///app/a.mjs:1:2",
      "    at async main (file:///app/a.mjs:3:1)",
      "    at /app/x.js:1:2",
      "Traceback (most recent call last):",
      "uncaught exception",
    ]) {
      expect(classifyRunnerExit({ ...exit1, stderr, usage: { turns: 50 } }).status, stderr).toBe("error");
    }
  });

  it("stderr is never echoed into the reason", () => {
    expect(classifyRunnerExit({ ...exit1, stderr: "Error: sk-secret" }).reason).not.toContain("sk-secret");
  });

  it("no budget flag, or no evidence, is an error", () => {
    expect(classifyRunnerExit({ ...exit1, budgetFlagSet: false, usage: { usd: 5 } }).status).toBe("error");
    expect(classifyRunnerExit({ ...exit1 }).status).toBe("error");
  });
});

describe("seatBudgetFromPolicy / estimatePanel", () => {
  it("maps policy to a seat budget; perSeatUsd 0 disables the dollar cap", () => {
    expect(seatBudgetFromPolicy(base, "judge")).toEqual({ maxTurns: 50, maxUsd: 5, deadlineMs: 600_000 });
    expect(seatBudgetFromPolicy(loadPolicy({ budget: { perSeatUsd: 0 } }), "hunter").maxUsd).toBeUndefined();
  });

  it("sums known seats and lists unknown ones", () => {
    const s = [hunter("a"), hunter("b", "mystery"), judge(1)];
    expect(estimatePanel(s, estimate)).toEqual({ usd: 6, unknownSeats: ["hunter:b:1"] });
    expect(estimatePanel([hunter("x", "mystery")], estimate)).toEqual({ unknownSeats: ["hunter:x:1"] });
  });
});
