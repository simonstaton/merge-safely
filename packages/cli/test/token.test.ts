import { describe, expect, it } from "vitest";
import type { Exec } from "../src/exec.js";
import { discoverGithubToken, tokenIdentity } from "../src/token.js";

const gh =
  (out: string, code = 0): Exec =>
  async () => ({ code, stdout: out, stderr: "" });

describe("GitHub token discovery", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN, then gh auth token", async () => {
    expect(await discoverGithubToken({ GITHUB_TOKEN: "a1", GH_TOKEN: "b2" }, gh("c3"))).toEqual({
      token: "a1",
      source: "GITHUB_TOKEN",
    });
    expect(await discoverGithubToken({ GITHUB_TOKEN: " ", GH_TOKEN: "b2" }, gh("c3"))).toEqual({
      token: "b2",
      source: "GH_TOKEN",
    });
    expect(await discoverGithubToken({}, gh("gho_xyz\n"))).toEqual({ token: "gho_xyz", source: "gh" });
    expect(await discoverGithubToken({}, gh("", 1))).toBeUndefined();
    expect(await discoverGithubToken({}, gh("", -1))).toBeUndefined();
  });

  it("classifies App/Actions tokens", () => {
    expect(tokenIdentity({ token: "ghs_x", source: "GH_TOKEN" }, {})).toBe("app");
    expect(tokenIdentity({ token: "abc", source: "GITHUB_TOKEN" }, { GITHUB_ACTIONS: "true" })).toBe("app");
    expect(tokenIdentity({ token: "ghp_x", source: "GITHUB_TOKEN" }, {})).toBe("user");
    expect(tokenIdentity({ token: "gho_x", source: "gh" }, { GITHUB_ACTIONS: "true" })).toBe("user");
  });
});
