import { describe, expect, it } from "vitest";
import { APP_PERMISSIONS, createAppJwtOctokit, octokitFromToken } from "./auth.js";
import { collectPages, errorStatus, type OctokitLike } from "./octokit.js";

describe("OctokitLike", () => {
  it("is satisfied by a real @octokit/rest client (type-level) without network", () => {
    const real: OctokitLike = octokitFromToken("not-a-real-token");
    expect(typeof real.pulls.get).toBe("function");
    expect(typeof real.checks.update).toBe("function");
  });

  it("builds an app JWT client without contacting GitHub", () => {
    const client: OctokitLike = createAppJwtOctokit(
      1,
      "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
    );
    expect(typeof client.teams.getMembershipForUserInOrg).toBe("function");
  });

  it("exports the least-privilege permission set", () => {
    expect(APP_PERMISSIONS).toEqual({
      checks: "write",
      pull_requests: "write",
      contents: "read",
      members: "read",
      metadata: "read",
    });
  });
});

describe("collectPages", () => {
  it("stops on a short page and caps items", async () => {
    const calls: number[] = [];
    const items = await collectPages(
      async (page, perPage) => {
        calls.push(page);
        return page < 3 ? Array.from({ length: perPage }, (_, i) => page * 10 + i) : [99];
      },
      { perPage: 2 },
    );
    expect(items).toEqual([10, 11, 20, 21, 99]);
    expect(calls).toEqual([1, 2, 3]);
    const capped = await collectPages(async (_p, perPage) => Array.from({ length: perPage }, () => 1), {
      perPage: 5,
      maxItems: 7,
    });
    expect(capped).toHaveLength(7);
  });

  it("reads status from request errors", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus(new Error("x"))).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
  });
});
