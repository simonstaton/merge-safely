import type { ModelInfo } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { redactDiagnostics as redact } from "../redact.js";
import { secretStrings, systemErrorCode } from "./errors.js";
import { RunGuard } from "./guard.js";
import {
  AbortedError,
  backoffDelay,
  DEFAULT_RETRY,
  parseRetryAfter,
  RetryBeyondDeadlineError,
  sleep,
  withRetry,
} from "./retry.js";
import { isStrictCompatible, sanitizeSchema } from "./schema.js";
import { addUsage } from "./usage.js";

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: "openai",
    name: "m",
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 1000,
    maxOutputTokens: 100,
    tier: "mid",
    ...over,
  };
}

describe("usage", () => {
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
  it("withRetry fails at once when the retry would land after the deadline", async () => {
    let n = 0;
    const t0 = Date.now();
    const p = withRetry(
      async () => {
        n++;
        throw new Error("429");
      },
      {
        classify: () => ({ kind: "rate-limit", retryable: true, retryAfterMs: 30_000, message: "rate limited (429)" }),
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 1_000,
      },
    );
    await expect(p).rejects.toBeInstanceOf(RetryBeyondDeadlineError);
    await expect(p).rejects.toThrow(/rate limited beyond the seat deadline/);
    expect(n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(500);
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
    expect(systemErrorCode({ cause: { code: "EAI_AGAIN" } })).toBe("EAI_AGAIN");
    expect(systemErrorCode({ cause: { code: "UND_ERR_SOCKET" } })).toBe("UND_ERR_SOCKET");
    expect(systemErrorCode({ code: "insufficient_quota" })).toBeUndefined();
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
  it("tracks spend against maxUsd with the model's pricing", () => {
    const g = new RunGuard(
      { maxTurns: 2, deadlineMs: 10_000, maxUsd: 1 },
      model({ pricing: { inPerMTok: 1, outPerMTok: 1 } }),
    );
    expect(g.addUsage({ in: 600_000, out: 0 })).toBeCloseTo(0.6);
    expect(g.overBudget()).toBe(false);
    expect(g.estimated).toBe(false);
    g.addUsage({ in: 0, out: 600_000 });
    expect(g.overBudget()).toBe(true);
    g.dispose();
  });
  it("prices unknown models at the registry's pessimistic rate, and zero-cost at zero", () => {
    const g = new RunGuard({ maxTurns: 2, deadlineMs: 10_000, maxUsd: 1 }, model());
    expect(g.estimated).toBe(true);
    expect(g.addUsage({ in: 1_000_000, out: 0 })).toBeGreaterThanOrEqual(5);
    expect(g.overBudget()).toBe(true);
    const z = new RunGuard({ maxTurns: 2, deadlineMs: 10_000, maxUsd: 1 }, model({ zeroCost: true }));
    expect(z.addUsage({ in: 1_000_000, out: 1_000_000 })).toBe(0);
    g.dispose();
    z.dispose();
  });
  it("aborts on deadline and external signal", async () => {
    const g = new RunGuard({ maxTurns: 2, deadlineMs: 5 }, model());
    expect(g.deadlineAt).toBeLessThanOrEqual(Date.now() + 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(g.signal.aborted).toBe(true);
    expect(g.stopReason).toBe("timeout");
    const ac = new AbortController();
    ac.abort();
    const g2 = new RunGuard({ maxTurns: 2, deadlineMs: 10_000 }, model(), ac.signal);
    expect(g2.stopReason).toBe("aborted");
    g.dispose();
    g2.dispose();
  });
});
