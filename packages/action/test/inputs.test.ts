import { describe, expect, it } from "vitest";
import { normalisePolicyPath, readInputs } from "../src/inputs.js";

const get = (m: Record<string, string>) => (n: string) => (m[n] ?? "").trim();

describe("readInputs", () => {
  it("applies the action.yml defaults", () => {
    const i = readInputs(get({ connections: "x: {}" }));
    expect(i).toMatchObject({
      policyPath: ".merge-safely.yml",
      policyExplicit: false,
      failOnBlock: true,
      store: "checkrun",
      concurrency: 2,
    });
    expect(i.prNumber).toBeUndefined();
    expect(i.headSha).toBeUndefined();
    expect(i.slackWebhook).toBeUndefined();
    expect(i.verdictAppSlugs).toEqual(["github-actions"]);
  });

  it("parses verdict-app-slugs", () => {
    expect(
      readInputs(get({ "verdict-app-slugs": "merge-safely, github-actions ,Merge-Safely" })).verdictAppSlugs,
    ).toEqual(["merge-safely", "github-actions"]);
    expect(() => readInputs(get({ "verdict-app-slugs": "bad slug!" }))).toThrow(/not a GitHub App slug/);
  });

  it("parses every input", () => {
    const i = readInputs(
      get({
        policy: "./config/merge-safely.yml",
        "github-token": "ghs_x",
        "fail-on-block": "False",
        concurrency: "4",
        "pr-number": "12",
        "head-sha": "A".repeat(40),
        "slack-webhook": "https://hooks.slack.com/services/T/B/x",
      }),
    );
    expect(i).toMatchObject({
      policyPath: "config/merge-safely.yml",
      policyExplicit: true,
      githubToken: "ghs_x",
      failOnBlock: false,
      concurrency: 4,
      prNumber: 12,
      headSha: "a".repeat(40),
      slackWebhook: "https://hooks.slack.com/services/T/B/x",
    });
  });

  it.each([
    [{ "fail-on-block": "maybe" }, /fail-on-block must be true or false/],
    [{ concurrency: "0" }, /concurrency must be an integer from 1 to 16/],
    [{ concurrency: "2.5" }, /concurrency/],
    [{ "pr-number": "-3" }, /pr-number/],
    [{ "head-sha": "abc123" }, /head-sha must be a full commit SHA \(40 or 64 hex characters\)/],
    [{ store: "sqlite" }, /store must be one of: checkrun/],
    [{ policy: "../secrets.yml" }, /policy must be a path inside the repository/],
    [{ policy: "/etc/passwd" }, /policy must be a path inside the repository/],
  ])("rejects %o", (m, re) => {
    expect(() => readInputs(get(m))).toThrow(re);
  });

  it("normalises policy paths", () => {
    expect(normalisePolicyPath("")).toBe(".merge-safely.yml");
    expect(normalisePolicyPath("a/./b/../c.yml")).toBe("a/c.yml");
    expect(normalisePolicyPath(".github\\merge-safely.yml")).toBe(".github/merge-safely.yml");
  });
});
