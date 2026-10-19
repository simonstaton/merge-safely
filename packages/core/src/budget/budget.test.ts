import { describe, expect, it } from "vitest";
import { loadPolicy } from "../policy/index.js";
import type { ModelRef, ModelTierClass, Seat } from "../types.js";
import {
  AlertLatch,
  admit,
  CEILING_POLICY_KEYS,
  classifyRunnerExit,
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

  it("returns unchanged when already within budget", () => {
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      limitUsd: 16,
      alreadySpentUsd: 0,
      quorumRequired: 2,
    });
    expect(r).toEqual({ seats, steps: [], withinBudget: true });
  });

  it("steps hunters first and records downgradedFrom", () => {
    // hunters to haiku: 4*0.5 + 8 = 10
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      limitUsd: 10,
      alreadySpentUsd: 0,
      quorumRequired: 2,
    });
    expect(r.withinBudget).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model"]);
    expect(r.steps[0]).toMatchObject({ from: "c/sonnet", to: "c/haiku" });
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
      estimate,
      cheaper,
      tierOf,
      limitUsd: 8,
      alreadySpentUsd: 0,
      quorumRequired: 2,
    });
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model"]);
    expect(r.withinBudget).toBe(true);
    expect(r.seats.filter((s) => s.role === "judge").every((s) => s.model.name === "sonnet")).toBe(true);
  });

  it("does not drop judges below hunters (with and without tierOf)", () => {
    const s = [hunter("intent", "sonnet"), judge(1, "sonnet")];
    for (const t of [tierOf, undefined]) {
      const r = downgradeLadder({
        seats: s,
        policy: base,
        estimate,
        cheaper,
        tierOf: t,
        limitUsd: 0.6,
        alreadySpentUsd: 0,
        quorumRequired: 1,
      });
      // hunters -> haiku; judge sonnet -> haiku would be equal to hunters (allowed by tier) only with tierOf
      const j = r.seats.find((x) => x.role === "judge");
      if (t) expect(j?.model.name).toBe("haiku");
      expect(r.withinBudget).toBe(false);
      expect(r.steps.at(-1)?.step).toBe("block");
    }
    // Hunters stuck at mid (no cheaper model): a judge may not step below mid.
    LADDER.stuck = { tier: "mid", usd: 2 };
    const stuck = [hunter("intent", "stuck"), judge(1, "sonnet")];
    const r = downgradeLadder({
      seats: stuck,
      policy: base,
      estimate,
      cheaper,
      tierOf,
      limitUsd: 1,
      alreadySpentUsd: 0,
      quorumRequired: 1,
    });
    expect(r.seats.find((x) => x.role === "judge")?.model.name).toBe("sonnet");
    expect(r.steps.map((x) => x.step)).toEqual(["block"]);
    delete LADDER.stuck;
  });

  it("drops hunter seats to the quorum minimum, keeping lenses listed first", () => {
    // after hunters->haiku and judges->sonnet: 4*0.5 + 2*2 = 6; need <= 5 → drop 2 hunters (5)
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      tierOf,
      limitUsd: 5,
      alreadySpentUsd: 0,
      quorumRequired: 2,
    });
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model", "seat-count"]);
    expect(r.withinBudget).toBe(true);
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["intent", "correctness"]);
    expect(r.steps[2]).toMatchObject({ from: "4 hunters", to: "2 hunters" });
  });

  it("honours an explicit lens priority", () => {
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      tierOf,
      limitUsd: 5,
      alreadySpentUsd: 0,
      quorumRequired: 2,
      lensPriority: ["security", "repro"],
    });
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["repro", "security"]);
  });

  it("blocks when nothing fits, counting what was already spent", () => {
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      tierOf,
      limitUsd: 25,
      alreadySpentUsd: 24,
      quorumRequired: 2,
    });
    expect(r.withinBudget).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(["hunters-model", "judges-model", "seat-count", "block"]);
    expect(r.seats.filter((s) => s.role === "hunter")).toHaveLength(2);
    expect(r.steps.at(-1)?.reason).toContain("budget.perChangeUsd");
  });

  it("onOverBudget: block skips straight to block", () => {
    const policy = loadPolicy({ budget: { onOverBudget: "block" } });
    const r = downgradeLadder({
      seats,
      policy,
      estimate,
      cheaper,
      limitUsd: 10,
      alreadySpentUsd: 0,
      quorumRequired: 2,
    });
    expect(r.steps.map((s) => s.step)).toEqual(["block"]);
    expect(r.seats).toBe(seats);
  });

  it("a disabled limit is always within budget", () => {
    const r = downgradeLadder({
      seats,
      policy: base,
      estimate,
      cheaper,
      limitUsd: 0,
      alreadySpentUsd: 1e9,
      quorumRequired: 2,
    });
    expect(r.withinBudget).toBe(true);
  });
});

describe("classifyRunnerExit", () => {
  const caps = { maxUsd: 5, maxTurns: 50, deadlineMs: 600_000 };

  it("exit 0 is ok", () => {
    expect(classifyRunnerExit({ exitCode: 0, stderr: "", budgetFlagSet: true, caps, wallMs: 1000 }).status).toBe("ok");
  });

  it("timedOut is timeout", () => {
    const r = classifyRunnerExit({
      exitCode: null,
      signal: "SIGKILL",
      stderr: "",
      budgetFlagSet: true,
      caps,
      wallMs: 1,
      timedOut: true,
    });
    expect(r.status).toBe("timeout");
    expect(r.recovery).toContain("budget.seatDeadlineMs");
  });

  it("non-zero exit at the usd cap with the flag set is a budget pause", () => {
    const r = classifyRunnerExit({
      exitCode: 1,
      stderr: "Error: exceeded max budget",
      budgetFlagSet: true,
      usage: { usd: 4.8 },
      caps,
      wallMs: 1000,
    });
    expect(r.status).toBe("budget-exceeded");
    expect(r.recovery).toBe("Raise budget.perSeatUsd and re-run the check.");
  });

  it("turn cap names seatMaxTurns", () => {
    const r = classifyRunnerExit({
      exitCode: 1,
      stderr: "",
      budgetFlagSet: true,
      usage: { turns: 50 },
      caps,
      wallMs: 1,
    });
    expect(r.status).toBe("budget-exceeded");
    expect(r.recovery).toContain("budget.seatMaxTurns");
  });

  it("a stack trace means a crash even at the cap", () => {
    const stderr = "TypeError: x is undefined\n    at run (/app/runner.js:10:5)\n    at main (/app/index.js:3:1)";
    const r = classifyRunnerExit({ exitCode: 1, stderr, budgetFlagSet: true, usage: { usd: 5 }, caps, wallMs: 1 });
    expect(r.status).toBe("error");
    expect(r.reason).not.toContain("TypeError"); // stderr is never echoed
  });

  it("no budget flag, or usage far from cap, is an error", () => {
    expect(
      classifyRunnerExit({ exitCode: 1, stderr: "", budgetFlagSet: false, usage: { usd: 5 }, caps, wallMs: 1 }).status,
    ).toBe("error");
    expect(
      classifyRunnerExit({ exitCode: 1, stderr: "", budgetFlagSet: true, usage: { usd: 1 }, caps, wallMs: 1 }).status,
    ).toBe("error");
    expect(classifyRunnerExit({ exitCode: 1, stderr: "", budgetFlagSet: true, caps, wallMs: 1 }).status).toBe("error");
  });

  it("non-zero exit past the deadline is a timeout", () => {
    expect(classifyRunnerExit({ exitCode: 137, stderr: "", budgetFlagSet: false, caps, wallMs: 600_001 }).status).toBe(
      "timeout",
    );
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
