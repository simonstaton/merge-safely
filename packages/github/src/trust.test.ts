import { DEFAULT_POLICY, type Principal } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { repo } from "../test/builders.js";
import { callsTo, fakeOctokit } from "../test/fake-octokit.js";
import { allowlistTrust, githubTeamsTrust, trustFromPolicy } from "./trust.js";

const human = (login: string): Principal => ({ kind: "human", login });

describe("githubTeamsTrust", () => {
  it("trusts active team members and bare logins, caches lookups for 5 minutes", async () => {
    let t = 0;
    const { octokit, calls, state } = fakeOctokit({
      memberships: { "acme/devs:alice": "active", "acme/devs:pat": "pending" },
    });
    const trust = githubTeamsTrust({ octokit, trusted: ["acme/devs", "@Carol"], now: () => t });
    expect(await trust.classify(human("alice"), repo)).toBe("trusted");
    expect(await trust.classify(human("ALICE"), repo)).toBe("trusted");
    expect(await trust.classify(human("pat"), repo)).toBe("standard");
    expect(await trust.classify(human("carol"), repo)).toBe("trusted");
    expect(await trust.classify(human("dave"), repo)).toBe("standard");
    expect(callsTo(calls, "teams.getMembershipForUserInOrg")).toHaveLength(3); // alice, pat, dave (404 cached)
    await trust.classify(human("dave"), repo);
    expect(callsTo(calls, "teams.getMembershipForUserInOrg")).toHaveLength(3);
    // After the TTL a removed member is no longer trusted.
    state.memberships["acme/devs:alice"] = "404";
    t = 5 * 60 * 1000 + 1;
    expect(await trust.classify(human("alice"), repo)).toBe("standard");
  });

  it("blocked wins over trusted, for logins and teams", async () => {
    const { octokit } = fakeOctokit({ memberships: { "acme/devs:eve": "active", "acme/banned:eve": "active" } });
    expect(
      await githubTeamsTrust({ octokit, trusted: ["acme/devs"], blocked: ["eve"] }).classify(human("eve"), repo),
    ).toBe("blocked");
    expect(
      await githubTeamsTrust({ octokit, trusted: ["acme/devs"], blocked: ["acme/banned"] }).classify(
        human("eve"),
        repo,
      ),
    ).toBe("blocked");
  });

  it("treats bots and agents as standard by default, blocked still wins", async () => {
    const { octokit } = fakeOctokit();
    const trust = githubTeamsTrust({ octokit, trusted: ["renovate[bot]", "alice"], blocked: ["evilbot[bot]"] });
    expect(await trust.classify({ kind: "bot", login: "renovate[bot]" }, repo)).toBe("standard");
    expect(await trust.classify({ kind: "agent", login: "alice" }, repo)).toBe("standard");
    expect(await trust.classify({ kind: "bot", login: "evilbot[bot]" }, repo)).toBe("blocked");
    const lax = githubTeamsTrust({ octokit, trusted: ["renovate[bot]"], botsAreStandard: false });
    expect(await lax.classify({ kind: "bot", login: "renovate[bot]" }, repo)).toBe("trusted");
  });

  it("fails closed on lookup errors without caching them", async () => {
    const { octokit, calls, state } = fakeOctokit({ memberships: { "acme/devs:alice": "500" } });
    const trust = githubTeamsTrust({ octokit, trusted: ["acme/devs"] });
    expect(await trust.classify(human("alice"), repo)).toBe("standard");
    state.memberships["acme/devs:alice"] = "active";
    expect(await trust.classify(human("alice"), repo)).toBe("trusted");
    expect(callsTo(calls, "teams.getMembershipForUserInOrg")).toHaveLength(2);
  });
});

describe("allowlistTrust / trustFromPolicy", () => {
  it("classifies from static lists", async () => {
    const trust = allowlistTrust({ trusted: ["alice", "acme/devs"], blocked: ["mallory"] });
    expect(await trust.classify(human("Alice"), repo)).toBe("trusted");
    expect(await trust.classify(human("acme/devs"), repo)).toBe("standard");
    expect(await trust.classify(human("mallory"), repo)).toBe("blocked");
    expect(await trust.classify({ kind: "bot", login: "alice" }, repo)).toBe("standard");
  });

  it("picks the provider from policy", async () => {
    const base = DEFAULT_POLICY.trust;
    const { octokit, calls } = fakeOctokit({ memberships: { "acme/devs:alice": "active" } });
    const teams = trustFromPolicy({ trust: { ...base, provider: "github-teams", trusted: ["acme/devs"] } }, octokit);
    expect(await teams.classify(human("alice"), repo)).toBe("trusted");
    expect(callsTo(calls, "teams.getMembershipForUserInOrg")).toHaveLength(1);
    expect(() => trustFromPolicy({ trust: { ...base, provider: "github-teams" } })).toThrow(/members: read/);
    const allow = trustFromPolicy({ trust: { ...base, provider: "allowlist", trusted: ["bob"] } });
    expect(await allow.classify(human("bob"), repo)).toBe("trusted");
    const none = trustFromPolicy({ trust: { ...base, provider: "none", trusted: ["bob"], blocked: ["eve"] } });
    expect(await none.classify(human("bob"), repo)).toBe("standard");
    expect(await none.classify(human("eve"), repo)).toBe("blocked");
  });
});
