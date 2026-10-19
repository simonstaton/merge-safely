import type { Change, Finding, HumanDigest, ReportEvent, Tier, Verdict } from "@merge-safely/core";
import { describe, expect, it, vi } from "vitest";
import { escapeMrkdwn, type SlackMessage } from "./format.js";
import { DEFAULT_REPORT_EVENTS, slackEscalation, slackReporter } from "./index.js";
import { postToWebhook, SlackWebhookError, scrubWebhook } from "./webhook.js";

const URL_ = "https://hooks.slack.com/services/T000TEST/B000TEST/SuperSecretWebhookToken123";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<number | Error | "hang">) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(`aborted request to ${String(url)}`)));
      });
    }
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? "ok" : `error at ${String(url)}`, { status: r ?? 200 });
  });
  return {
    fetch: f as unknown as typeof fetch,
    calls,
    body: (i = 0) => JSON.parse(String(calls[i]?.init.body)) as SlackMessage,
  };
}

const tier: Tier = {
  level: 3,
  score: 87.4,
  factors: { loc: 400, files: 12, modules: 3, criticalPathHits: [] },
  reasons: [],
};
const blocker = (n: number): Finding => ({
  id: `f${n}`,
  severity: "blocker",
  class: "lock-risk",
  title: `Blocker ${n} <!channel>`,
  detail: "d",
  file: "db/migrations/001.sql",
  line: n,
});
const verdict: Verdict = {
  repo: { host: "github.com", owner: "acme", name: "web" },
  number: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  kind: "machine",
  decision: "block",
  tier,
  round: 1,
  triaged: false,
  seats: [],
  findings: [...[1, 2, 3, 4, 5, 6, 7].map(blocker), { ...blocker(8), severity: "nit", title: "a nit" }],
  quorum: { required: 2, passed: 1, blocked: 2, invalid: 0 },
  cost: { tokens: { in: 0, out: 0 }, bySeat: {} },
  createdAt: "2026-10-19T00:00:00.000Z",
  policyHash: "deadbeefcafebabe1234",
};
const digest: HumanDigest = { headline: "Tier 3 change blocked: migration takes a table lock", markdown: "", text: "" };
const change: Change = {
  repo: verdict.repo,
  number: 42,
  headSha: verdict.headSha,
  baseSha: "b",
  baseRef: "main",
  headRef: "feat",
  title: "t",
  body: "b",
  author: { kind: "human", login: "dev" },
  files: [],
  stats: { additions: 1, deletions: 0, files: 1 },
  labels: [],
  draft: false,
  ciStatus: "success",
};

describe("slackEscalation", () => {
  it("posts a Block Kit message and returns a uuid handle without url", async () => {
    const ff = fakeFetch([200]);
    const esc = slackEscalation({ webhookUrl: URL_, fetch: ff.fetch, channelHint: "#reviews" });
    expect(esc.resolve).toBeUndefined();
    const h = await esc.request(verdict, digest);
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.url).toBeUndefined();
    expect(Number.isNaN(Date.parse(h.createdAt))).toBe(false);

    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]?.url).toBe(URL_);
    expect(ff.calls[0]?.init.method).toBe("POST");
    const msg = ff.body();
    expect(msg.text).toContain("acme/web#42");
    const types = msg.blocks?.map((b) => b.type);
    expect(types).toEqual(["header", "section", "section", "section", "context"]);
    const json = JSON.stringify(msg);
    expect(json).toContain(digest.headline);
    expect(json).toContain("https://github.com/acme/web/pull/42");
    expect(json).toContain("Tier*\\n3");
    expect(json).toContain("1 pass / 2 block / 0 invalid (need 2)");
    expect(json).toContain("Blocker 5");
    expect(json).not.toContain("Blocker 6");
    expect(json).toContain("and 2 more");
    expect(json).not.toContain("a nit");
    expect(json).toContain(`merge-safely verdict --repo acme/web --pr 42 --sha ${verdict.headSha} --pass|--block`);
    expect(json).toContain("for #reviews");
    // untrusted text cannot ping the channel
    expect(json).not.toContain("<!channel>");
    expect(json).toContain("&lt;!channel&gt;");
  });

  it("retries once on 5xx", async () => {
    const ff = fakeFetch([503, 200]);
    await slackEscalation({ webhookUrl: URL_, fetch: ff.fetch }).request(verdict, digest);
    expect(ff.calls).toHaveLength(2);
  });

  it("throws on failure without the webhook URL in the message", async () => {
    const ff = fakeFetch([500, 502]);
    const err = await slackEscalation({ webhookUrl: URL_, fetch: ff.fetch })
      .request(verdict, digest)
      .catch((e: unknown) => e);
    expect(ff.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(SlackWebhookError);
    expect((err as SlackWebhookError).status).toBe(502);
    expect(String((err as Error).message)).toContain("HTTP 502");
    expect(String((err as Error).message)).not.toContain("SuperSecretWebhookToken123");
    expect(String((err as Error).message)).not.toContain("hooks.slack.com");
  });

  it("does not retry 4xx", async () => {
    const ff = fakeFetch([404, 200]);
    await expect(slackEscalation({ webhookUrl: URL_, fetch: ff.fetch }).request(verdict, digest)).rejects.toThrow(
      /HTTP 404/,
    );
    expect(ff.calls).toHaveLength(1);
  });

  it("rejects bad webhook URLs without echoing them", () => {
    expect(() => slackEscalation({ webhookUrl: "not a url SuperSecret" })).toThrow(/not a valid URL/);
    try {
      slackEscalation({ webhookUrl: "http://hooks.slack.com/services/SuperSecret" });
      expect.unreachable();
    } catch (err: unknown) {
      expect(String(err)).toContain("must use https");
      expect(String(err)).not.toContain("SuperSecret");
    }
  });
});

describe("postToWebhook", () => {
  it("times out", async () => {
    const ff = fakeFetch(["hang"]);
    await expect(postToWebhook(URL_, {}, { fetch: ff.fetch, timeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
    expect(ff.calls).toHaveLength(1);
  });

  it("retries a network error once and scrubs the URL from it", async () => {
    const ff = fakeFetch([new Error(`connect ECONNREFUSED ${URL_}`)]);
    const err = await postToWebhook(URL_, {}, { fetch: ff.fetch }).catch((e: unknown) => e);
    expect(ff.calls).toHaveLength(2);
    expect(String(err)).toContain("ECONNREFUSED");
    expect(String(err)).not.toContain("SuperSecretWebhookToken123");
  });

  it("scrubWebhook removes the url, any slack hook url and the bare path", () => {
    expect(scrubWebhook(`a ${URL_} b`, URL_)).toBe("a [webhook] b");
    expect(scrubWebhook("x https://hooks.slack.com/services/OTHER/ONE", URL_)).toBe("x [webhook]");
    expect(scrubWebhook("path /services/T000TEST/B000TEST/SuperSecretWebhookToken123", URL_)).toBe("path [webhook]");
  });
});

describe("slackReporter", () => {
  const events: ReportEvent[] = [
    { type: "pending", change, round: 1 },
    { type: "verdict", change, verdict, digest },
    { type: "escalated", change, verdict, digest, handle: { id: "h", createdAt: "x" } },
    { type: "budget-blocked", change, tier, reason: "per-change ceiling reached", ceiling: "$25", digest },
    { type: "error", change, error: "runner crashed <@U123>", round: 2 },
  ];

  it("posts default events and never pending", async () => {
    expect(DEFAULT_REPORT_EVENTS).toEqual(["verdict", "escalated", "budget-blocked", "error"]);
    const ff = fakeFetch([200]);
    const r = slackReporter({ webhookUrl: URL_, fetch: ff.fetch });
    for (const e of events) await r.report(e);
    expect(ff.calls).toHaveLength(4);
    const texts = ff.calls.map((_c, i) => ff.body(i).text);
    expect(texts[0]).toMatch(
      /^:no_entry: \*BLOCK\* <https:\/\/github.com\/acme\/web\/pull\/42\|acme\/web#42> · tier 3/,
    );
    expect(texts[0]).toContain("7 blockers");
    expect(texts[1]).toContain("*ESCALATED*");
    expect(texts[2]).toContain("*BUDGET BLOCKED*");
    expect(texts[2]).toContain("ceiling $25");
    expect(texts[3]).toContain("*ERROR*");
    expect(texts[3]).toContain("round 2");
    expect(texts[3]).toContain("&lt;@U123&gt;");
    expect(ff.body(0).blocks?.[0]?.type).toBe("section");
  });

  it("filters to the requested events and ignores pending even if asked", async () => {
    const ff = fakeFetch([200]);
    const r = slackReporter({ webhookUrl: URL_, fetch: ff.fetch, events: ["error", "pending"] });
    for (const e of events) await r.report(e);
    expect(ff.calls).toHaveLength(1);
    expect(ff.body().text).toContain("*ERROR*");
  });

  it("uses change.url when present", async () => {
    const ff = fakeFetch([200]);
    await slackReporter({ webhookUrl: URL_, fetch: ff.fetch }).report({
      type: "error",
      change: { ...change, url: "https://ghe.example.com/acme/web/pull/42" },
      error: "x",
      round: 1,
    });
    expect(ff.body().text).toContain("<https://ghe.example.com/acme/web/pull/42|acme/web#42>");
  });

  it("never throws; logs without the webhook URL", async () => {
    const warn = vi.fn();
    const ff = fakeFetch([500]);
    const r = slackReporter({ webhookUrl: URL_, fetch: ff.fetch, logger: { warn } });
    await expect(r.report(events[1] as ReportEvent)).resolves.toBeUndefined();
    expect(ff.calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("could not post verdict event");
    expect(logged).not.toContain("SuperSecretWebhookToken123");
    expect(logged).not.toContain("hooks.slack.com");

    const throwing = slackReporter({
      webhookUrl: URL_,
      fetch: fakeFetch([new Error("boom")]).fetch,
      logger: {
        warn: () => {
          throw new Error("logger broken");
        },
      },
    });
    await expect(throwing.report(events[4] as ReportEvent)).resolves.toBeUndefined();
  });
});

describe("escapeMrkdwn", () => {
  it("escapes control characters", () => {
    expect(escapeMrkdwn("a & <b> <!here>")).toBe("a &amp; &lt;b&gt; &lt;!here&gt;");
  });
});
