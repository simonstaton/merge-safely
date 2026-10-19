import { describe, expect, it } from "vitest";
import { RunGuard } from "./guard.js";
import { addUsage, priceUsage } from "./pricing.js";
import { redact, secretStrings, systemErrorCode } from "./redact.js";
import { AbortedError, backoffDelay, DEFAULT_RETRY, parseRetryAfter, sleep, withRetry } from "./retry.js";
import { isStrictCompatible, sanitizeSchema } from "./schema.js";

describe("pricing", () => {
  it("prices uncached, cached and output tokens", () => {
    const usd = priceUsage(
      { in: 1_000_000, out: 1_000_000, cachedIn: 1_000_000 },
      { pricing: { inPerMTok: 2, outPerMTok: 8, cachedInPerMTok: 0.5 } },
    );
    expect(usd).toBeCloseTo(10.5);
  });
  it("falls back to input rate for cached tokens and handles zero-cost and unknown", () => {
    expect(
      priceUsage({ in: 0, out: 0, cachedIn: 1_000_000 }, { pricing: { inPerMTok: 3, outPerMTok: 1 } }),
    ).toBeCloseTo(3);
    expect(priceUsage({ in: 5, out: 5 }, { zeroCost: true })).toBe(0);
    expect(priceUsage({ in: 5, out: 5 }, {})).toBeUndefined();
  });
  it("adds usage", () => {
    expect(addUsage({ in: 1, out: 2 }, { in: 3, out: 4, cachedIn: 5 })).toEqual({ in: 4, out: 6, cachedIn: 5 });
    expect(addUsage({ in: 1, out: 2 }, { in: 1, out: 1 })).toEqual({ in: 2, out: 3 });
  });
});

describe("retry helpers", () => {
  it("parses retry-after forms", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null, "150")).toBe(150);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), null, 4_000)).toBe(6_000);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
  it("prefers the server delay and caps exponential backoff", () => {
    expect(backoffDelay(0, { retryAfterMs: 1234 }, DEFAULT_RETRY)).toBe(1234);
    expect(backoffDelay(0, { retryAfterMs: 10 * 60_000 }, DEFAULT_RETRY)).toBe(60_000);
    const d = backoffDelay(10, {}, DEFAULT_RETRY);
    expect(d).toBeGreaterThanOrEqual(DEFAULT_RETRY.maxDelayMs / 2);
    expect(d).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });
  it("sleep rejects on abort", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
  });
  it("withRetry retries retryable failures then succeeds", async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        if (n++ < 2) throw new Error("x");
        return 7;
      },
      {
        classify: () => ({ kind: "server", retryable: true, message: "x" }),
        signal: new AbortController().signal,
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
      },
    );
    expect(v).toBe(7);
    expect(n).toBe(3);
  });
});

describe("redaction", () => {
  it("removes known secrets and key shapes", () => {
    const out = redact("key sk-abcdefghijklmnop123 and AIzaSyA1234567890abcdefghijk and Bearer abc.def.ghi and mine", [
      "mine",
    ]);
    expect(out).not.toMatch(/sk-abcdef|AIzaSy|abc\.def|mine/);
    expect(out).toContain("Bearer [REDACTED]");
  });
  it("redacts key-bearing query params", () => {
    expect(redact("GET https://x/v1?key=AAAA1234&x=1")).toBe("GET https://x/v1?key=[REDACTED]&x=1");
  });
  it("collects secret strings but not base urls", () => {
    expect(
      secretStrings({
        kind: "openai-compatible",
        baseUrl: "http://h",
        apiKey: "k-12345",
        headers: { a: "hv-123" },
      }).sort(),
    ).toEqual(["hv-123", "k-12345"]);
  });
  it("finds system error codes in cause chains", () => {
    expect(systemErrorCode({ cause: { cause: { code: "ECONNREFUSED" } } })).toBe("ECONNREFUSED");
    expect(systemErrorCode(new Error("x"))).toBeUndefined();
  });
});

describe("schema helpers", () => {
  it("strips $schema", () => {
    expect(
      sanitizeSchema({ $schema: "x", type: "object", properties: { a: { $schema: "y", type: "string" } } }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });
  it("detects strict compatibility", () => {
    const closed = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string" } },
    };
    expect(isStrictCompatible(closed)).toBe(true);
    expect(isStrictCompatible({ ...closed, required: [] })).toBe(false);
    expect(isStrictCompatible({ ...closed, additionalProperties: true })).toBe(false);
    expect(isStrictCompatible({ ...closed, properties: { a: { type: "string", maxLength: 3 } } })).toBe(false);
    expect(
      isStrictCompatible({
        ...closed,
        properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "string" } } } } },
      }),
    ).toBe(false);
  });
});

describe("RunGuard", () => {
  it("tracks spend against maxUsd", () => {
    const g = new RunGuard(
      { maxTurns: 2, deadlineMs: 10_000, maxUsd: 1 },
      { name: "m", pricing: { inPerMTok: 1, outPerMTok: 1 } },
    );
    expect(g.addUsage({ in: 600_000, out: 0 })).toBeCloseTo(0.6);
    expect(g.overBudget()).toBe(false);
    g.addUsage({ in: 0, out: 600_000 });
    expect(g.overBudget()).toBe(true);
    g.dispose();
  });
  it("aborts on deadline and external signal", async () => {
    const g = new RunGuard({ maxTurns: 2, deadlineMs: 5 }, { name: "m" });
    await new Promise((r) => setTimeout(r, 20));
    expect(g.signal.aborted).toBe(true);
    expect(g.stopReason).toBe("timeout");
    const ac = new AbortController();
    ac.abort();
    const g2 = new RunGuard({ maxTurns: 2, deadlineMs: 10_000 }, { name: "m" }, ac.signal);
    expect(g2.stopReason).toBe("aborted");
    g.dispose();
    g2.dispose();
  });
});
