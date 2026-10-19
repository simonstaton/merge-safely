import { describe, expect, it } from "vitest";
import { makeHarness, passOutput } from "../../test/orchestrator/fakes.js";
import { makeChange, makePolicy, makeSeat } from "../stages/test-helpers.js";
import { mapLimit } from "./limit.js";
import { connectionSecrets, estimateDiffChars, estimateSeatUsage, scrub } from "./util.js";

describe("mapLimit", () => {
  it("preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("handles empty input and silly limits", async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], 0, async (x) => x)).toEqual([1, 2]);
  });
});

describe("estimates", () => {
  it("grows with the diff and charges judges more under a second round", () => {
    const change = makeChange();
    const hunter = makeSeat({ role: "hunter" });
    const judge = makeSeat({ role: "judge", lens: "judge" });
    const small = estimateSeatUsage(hunter, { diffChars: 100, change, secondJudgeRound: false });
    const big = estimateSeatUsage(hunter, { diffChars: 100_000, change, secondJudgeRound: false });
    expect(big.in).toBeGreaterThan(small.in);
    const j1 = estimateSeatUsage(judge, { diffChars: 100, change, secondJudgeRound: false });
    const j2 = estimateSeatUsage(judge, { diffChars: 100, change, secondJudgeRound: true });
    expect(j2.in).toBeGreaterThan(j1.in);
    expect(estimateDiffChars(change)).toBeGreaterThan(0);
  });
});

describe("scrub", () => {
  it("removes connection secrets and secret shapes", () => {
    const secrets = connectionSecrets([
      { id: "a", provider: "x", kind: "api-key", createdAt: "", secret: { kind: "api-key", apiKey: "plainsecret99" } },
      {
        id: "b",
        provider: "y",
        kind: "openai-compatible",
        createdAt: "",
        secret: { kind: "openai-compatible", baseUrl: "http://x", headers: { "x-key": "headersecret1" } },
      },
    ]);
    const out = scrub("failed plainsecret99 / headersecret1 / ghp_abcdefghijklmnopqrstuvwxyz0123456789", secrets);
    expect(out).not.toContain("plainsecret99");
    expect(out).not.toContain("headersecret1");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("seat deadline", () => {
  it("aborts the runner at the seat deadline", async () => {
    const policy = makePolicy({
      panel: { t1: { hunters: ["correctness"], judges: 0 } },
      budget: { seatDeadlineMs: 1000 },
    });
    const h = makeHarness({
      policy,
      script: (call) =>
        new Promise((resolve) => {
          call.signal?.addEventListener("abort", () => resolve({ status: "timeout", output: null }));
          if (!call.signal) resolve({ output: passOutput() });
        }),
    });
    const r = await h.gate.review(h.ref);
    expect(r.verdict.seats[0]?.status).toBe("timeout");
    expect(r.verdict.decision).toBe("pending");
    expect(h.workspace.disposed).toBe(1);
  });
});
