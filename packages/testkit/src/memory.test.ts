import type { HumanDigest, Verdict } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { sampleFixtures } from "./fixtures.js";
import { fixedClock, memoryEscalation, memoryMetrics, memoryReporter, memoryTrust, silentLogger } from "./memory.js";

const digest: HumanDigest = { headline: "h", markdown: "m", text: "t" };

describe("memory fakes", () => {
  it("memoryReporter collects and filters events", async () => {
    const r = memoryReporter();
    const change = sampleFixtures.smallLogic.change;
    await r.report({ type: "pending", change, round: 1 });
    await r.report({ type: "error", change, error: "x", round: 1 });
    expect(r.events).toHaveLength(2);
    expect(r.ofType("error")[0]?.error).toBe("x");
    expect(r.last()?.type).toBe("error");
    r.clear();
    expect(r.events).toHaveLength(0);
  });

  it("memoryEscalation hands out handles and resolves once signed", async () => {
    const clock = fixedClock("2026-10-19T12:00:00.000Z");
    const e = memoryEscalation({ now: clock.now });
    const verdict = { decision: "block" } as unknown as Verdict;
    const h = await e.request(verdict, digest);
    expect(h).toEqual({ id: "esc-1", url: "https://escalation.example/esc-1", createdAt: "2026-10-19T12:00:00.000Z" });
    expect(await e.resolve(h)).toBeNull();
    const human = { decision: "pass", kind: "human" } as unknown as Verdict;
    e.sign(h.id, human);
    expect(await e.resolve(h)).toBe(human);
    expect(e.requests[0]?.verdict).toBe(verdict);
  });

  it("memoryMetrics sums by name", () => {
    const m = memoryMetrics();
    m.emit({ name: "seat.usd", value: 0.5, tags: {} });
    m.emit({ name: "seat.usd", value: 0.25, tags: {} });
    m.emit({ name: "verdict", value: 1, tags: { decision: "pass" } });
    expect(m.sum("seat.usd")).toBe(0.75);
    expect(m.named("verdict")).toHaveLength(1);
  });

  it("memoryTrust classifies by login with a fallback", async () => {
    const t = memoryTrust({ "dependabot[bot]": "trusted", mallory: "blocked" });
    const repo = sampleFixtures.smallLogic.change.repo;
    expect(await t.classify({ kind: "bot", login: "dependabot[bot]" }, repo)).toBe("trusted");
    expect(await t.classify({ kind: "human", login: "mallory" }, repo)).toBe("blocked");
    expect(await t.classify({ kind: "human", login: "alice" }, repo)).toBe("standard");
    expect(await t.classify({ kind: "human", login: "toString" }, repo)).toBe("standard");
    expect(t.calls).toHaveLength(4);
  });

  it("fixedClock only moves when told", () => {
    const c = fixedClock("2026-01-01T00:00:00.000Z");
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    c.advance(1500);
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    c.set("2027-01-01T00:00:00.000Z");
    expect(c.now().getUTCFullYear()).toBe(2027);
    expect(() => fixedClock("nope")).toThrow(/ISO/);
  });

  it("silentLogger records without printing", () => {
    const l = silentLogger();
    l.warn("careful", { seat: "s1" });
    l.info("hi");
    expect(l.entries).toEqual([
      { level: "warn", msg: "careful", meta: { seat: "s1" } },
      { level: "info", msg: "hi" },
    ]);
  });
});
