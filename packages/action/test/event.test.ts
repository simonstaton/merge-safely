import { describe, expect, it } from "vitest";
import {
  FORK_PULL_REQUEST_MESSAGE,
  isForkPullPayload,
  prNumberFromQueueRef,
  repoOf,
  resolveTrigger,
} from "../src/event.js";
import { BASE, fixture, HEAD, QUEUE } from "./helpers.js";

const env = { GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://github.com" };
const repo = { host: "github.com", owner: "acme", name: "app" };

describe("resolveTrigger", () => {
  it.each([
    ["pull_request", "pull_request.synchronize"],
    ["pull_request", "pull_request.ready_for_review"],
    ["pull_request_target", "pull_request_target.opened.fork"],
  ])("%s %s -> review of the event head", (name, fx) => {
    const t = resolveTrigger(name, fixture(fx), {}, env);
    expect(t).toMatchObject({ kind: "review", event: name, ref: { repo, number: 7 }, headSha: HEAD });
  });

  it("flags pull_request_target from a fork", () => {
    const t = resolveTrigger("pull_request_target", fixture("pull_request_target.opened.fork"), {}, env);
    expect(t).toMatchObject({ kind: "review", forkHint: true });
  });

  it("skips drafts with a notice", () => {
    const t = resolveTrigger("pull_request", fixture("pull_request.opened.draft"), {}, env);
    expect(t).toEqual({ kind: "skip", message: expect.stringMatching(/draft/) });
  });

  it("skips actions that do not change code", () => {
    expect(resolveTrigger("pull_request", fixture("pull_request.labeled"), {}, env).kind).toBe("skip");
  });

  it("refuses pull_request from a fork with the pull_request_target guidance", () => {
    expect(() => resolveTrigger("pull_request", fixture("pull_request.opened.fork"), {}, env)).toThrow(
      FORK_PULL_REQUEST_MESSAGE,
    );
    expect(FORK_PULL_REQUEST_MESSAGE).toMatch(/pull_request_target/);
    expect(FORK_PULL_REQUEST_MESSAGE).toMatch(/base branch/);
    expect(FORK_PULL_REQUEST_MESSAGE).toMatch(/allowedCommands/);
  });

  it("workflow_dispatch uses pr-number and no pinned head", () => {
    const t = resolveTrigger("workflow_dispatch", fixture("workflow_dispatch"), { prNumber: 7 }, env);
    expect(t).toEqual({ kind: "review", event: "workflow_dispatch", ref: { repo, number: 7 } });
  });

  it("workflow_dispatch without pr-number explains the wiring", () => {
    expect(() => resolveTrigger("workflow_dispatch", fixture("workflow_dispatch"), {}, env)).toThrow(
      /needs the pr-number input/,
    );
  });

  it("pr-number on another event is a mistake", () => {
    expect(() => resolveTrigger("pull_request", fixture("pull_request.synchronize"), { prNumber: 7 }, env)).toThrow(
      /only used on workflow_dispatch/,
    );
  });

  it("check_run rerequested -> review of that head, carrying the check's name and app for verification", () => {
    const t = resolveTrigger("check_run", fixture("check_run.rerequested"), {}, env);
    expect(t).toMatchObject({
      kind: "review",
      event: "check_run",
      ref: { repo, number: 7 },
      headSha: HEAD,
      checkRun: { name: "merge-safely/verdict", appSlug: "github-actions" },
    });
  });

  it("check_run with a custom check name is passed on for the policy to decide", () => {
    const p = fixture("check_run.rerequested");
    (p.check_run as { name: string }).name = "gate/ai";
    expect(resolveTrigger("check_run", p, {}, env)).toMatchObject({ checkRun: { name: "gate/ai" } });
  });

  it("check_suite events are ignored entirely", () => {
    expect(resolveTrigger("check_suite", fixture("check_suite.rerequested"), {}, env)).toMatchObject({
      kind: "skip",
      message: expect.stringMatching(/check_suite events are ignored/),
    });
  });

  it("check_run rerequested for a fork PR (no pull_requests) is skipped", () => {
    expect(resolveTrigger("check_run", fixture("check_run.rerequested.fork"), {}, env)).toMatchObject({
      kind: "skip",
      message: expect.stringMatching(/workflow_dispatch/),
    });
  });

  it("merge_group -> the queue commit and its PR", () => {
    const t = resolveTrigger("merge_group", fixture("merge_group.checks_requested"), {}, env);
    expect(t).toEqual({ kind: "merge-group", repo, headSha: QUEUE, baseRef: "main", prNumbers: [7] });
  });

  it("merge_group destroyed is skipped", () => {
    expect(resolveTrigger("merge_group", { action: "destroyed", repository: {} }, {}, env).kind).toBe("skip");
  });

  it("rejects unsupported events", () => {
    expect(() => resolveTrigger("push", {}, {}, env)).toThrow(/unsupported event "push"/);
    expect(() => resolveTrigger("", {}, {}, env)).toThrow(/unsupported event "\(none\)"/);
  });
});

describe("helpers", () => {
  it("parses merge-queue refs", () => {
    expect(prNumberFromQueueRef(`refs/heads/gh-readonly-queue/main/pr-123-${BASE}`)).toBe(123);
    expect(prNumberFromQueueRef(`gh-readonly-queue/release/v2/pr-9-${BASE}`)).toBe(9);
    expect(prNumberFromQueueRef("refs/heads/main")).toBeUndefined();
  });

  it("detects forks, including deleted ones", () => {
    expect(isForkPullPayload(fixture("pull_request.synchronize"))).toBe(false);
    expect(isForkPullPayload(fixture("pull_request.opened.fork"))).toBe(true);
    const deleted = fixture("pull_request.synchronize");
    const pr = deleted.pull_request as { head: { repo: unknown } };
    pr.head.repo = null;
    expect(isForkPullPayload(deleted)).toBe(true);
  });

  it("repoOf falls back to GITHUB_REPOSITORY and honours GHES hosts", () => {
    expect(repoOf({}, { GITHUB_REPOSITORY: "o/n", GITHUB_SERVER_URL: "https://ghe.example.com" })).toEqual({
      host: "ghe.example.com",
      owner: "o",
      name: "n",
    });
    expect(() => repoOf({}, {})).toThrow(/cannot tell which repository/);
  });
});
