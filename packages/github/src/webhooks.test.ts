import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { changeRefFromEvent, verifyWebhookSignature } from "./webhooks.js";

const secret = "s3cret";
const body = JSON.stringify({ hello: "world" });
const sign = (b: string | Buffer, s = secret) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature for string and Buffer payloads", () => {
    expect(verifyWebhookSignature(secret, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(secret, Buffer.from(body), sign(body))).toBe(true);
  });

  it("rejects invalid, malformed and missing signatures", () => {
    expect(verifyWebhookSignature(secret, body, sign(body, "other"))).toBe(false);
    expect(verifyWebhookSignature(secret, `${body} `, sign(body))).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha256=abc")).toBe(false);
    expect(verifyWebhookSignature(secret, body, sign(body).replace("sha256=", "sha1="))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature("", body, sign(body, ""))).toBe(false);
  });
});

const repository = { name: "widgets", owner: { login: "acme" }, html_url: "https://github.com/acme/widgets" };
const pr = (over: Record<string, unknown> = {}) => ({ number: 7, draft: false, head: { sha: "h1" }, ...over });
const ref = { repo: { host: "github.com", owner: "acme", name: "widgets" }, number: 7 };

describe("changeRefFromEvent", () => {
  it("maps reviewable pull_request actions", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review", "labeled"]) {
      expect(changeRefFromEvent("pull_request", { action, repository, pull_request: pr() })).toEqual({
        ref,
        headSha: "h1",
        action,
      });
    }
  });

  it("flags drafts except on ready_for_review", () => {
    expect(
      changeRefFromEvent("pull_request", { action: "opened", repository, pull_request: pr({ draft: true }) }),
    ).toEqual({ ref, headSha: "h1", action: "opened", draft: true });
    expect(
      changeRefFromEvent("pull_request", { action: "ready_for_review", repository, pull_request: pr({ draft: true }) })
        ?.draft,
    ).toBeUndefined();
  });

  it("ignores other pull_request actions and events", () => {
    expect(changeRefFromEvent("pull_request", { action: "closed", repository, pull_request: pr() })).toBeNull();
    expect(changeRefFromEvent("push", { action: "x", repository })).toBeNull();
    expect(changeRefFromEvent("pull_request", null)).toBeNull();
    expect(changeRefFromEvent("pull_request", { action: "opened", pull_request: pr() })).toBeNull();
  });

  it("uses the repository host for GHES", () => {
    const out = changeRefFromEvent("pull_request", {
      action: "opened",
      repository: { ...repository, html_url: "https://ghe.example.com/acme/widgets" },
      pull_request: pr(),
    });
    expect(out?.ref.repo.host).toBe("ghe.example.com");
  });

  it("maps rerequested check runs and suites", () => {
    expect(
      changeRefFromEvent("check_run", {
        action: "rerequested",
        repository,
        check_run: { name: "merge-safely/verdict", head_sha: "h2", pull_requests: [{ number: 7 }] },
      }),
    ).toEqual({ ref, headSha: "h2", action: "rerequested" });
    expect(
      changeRefFromEvent("check_suite", {
        action: "rerequested",
        repository,
        check_suite: { head_sha: "h3", pull_requests: [{ number: 7 }] },
      }),
    ).toEqual({ ref, headSha: "h3", action: "rerequested" });
  });

  it("ignores foreign check runs, other check actions and checks without a PR", () => {
    expect(
      changeRefFromEvent("check_run", {
        action: "rerequested",
        repository,
        check_run: { name: "tests", head_sha: "h", pull_requests: [{ number: 7 }] },
      }),
    ).toBeNull();
    expect(
      changeRefFromEvent("check_run", {
        action: "completed",
        repository,
        check_run: { name: "merge-safely/verdict", head_sha: "h", pull_requests: [{ number: 7 }] },
      }),
    ).toBeNull();
    expect(
      changeRefFromEvent("check_suite", {
        action: "rerequested",
        repository,
        check_suite: { head_sha: "h", pull_requests: [] },
      }),
    ).toBeNull();
  });
});
