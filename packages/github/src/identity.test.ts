import { describe, expect, it } from "vitest";
import { fakeOctokit } from "../test/fake-octokit.js";
import { isOwnApp, isOwnUser, resolveCheckName, resolveIdentity } from "./identity.js";

describe("identity", () => {
  it("discovers the App via GET /app, falls back to github-actions, honours overrides", async () => {
    expect(await resolveIdentity(fakeOctokit().octokit)).toEqual({
      appSlug: "merge-safely",
      appId: 1,
      botLogin: "merge-safely[bot]",
    });
    expect(await resolveIdentity(fakeOctokit({ self: null }).octokit)).toMatchObject({
      appSlug: "github-actions",
      botLogin: "github-actions[bot]",
    });
    expect(await resolveIdentity(fakeOctokit().octokit, { appSlug: "gate", botLogin: "gate-bot[bot]" })).toEqual({
      appSlug: "gate",
      botLogin: "gate-bot[bot]",
    });
  });

  it("matches apps by id when known, else slug; users by login", () => {
    expect(isOwnApp({ id: 1, slug: "other" }, { appSlug: "x", appId: 1, botLogin: "" })).toBe(true);
    expect(isOwnApp({ id: 2, slug: "x" }, { appSlug: "x", appId: 1, botLogin: "" })).toBe(false);
    expect(isOwnApp({ id: 2, slug: "X" }, { appSlug: "x", botLogin: "" })).toBe(true);
    expect(isOwnApp(null, { appSlug: "x", botLogin: "" })).toBe(false);
    expect(isOwnUser({ login: "Gate[bot]" }, { appSlug: "gate", botLogin: "gate[bot]" })).toBe(true);
    expect(isOwnUser(null, { appSlug: "gate", botLogin: "gate[bot]" })).toBe(false);
  });

  it("resolves the check name from override, policy, default", () => {
    const policy = { reporting: { checkName: "merge-safely/p" } } as Parameters<typeof resolveCheckName>[1];
    expect(resolveCheckName("merge-safely/o", policy)).toBe("merge-safely/o");
    expect(resolveCheckName(undefined, policy)).toBe("merge-safely/p");
    expect(resolveCheckName()).toBe("merge-safely/verdict");
  });
});
