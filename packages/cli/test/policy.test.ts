import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY, parsePolicy } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { lintPolicy, POLICY_TEMPLATE } from "../src/policy.js";
import { harness } from "./helpers.js";

describe("policy init", () => {
  it("writes a commented template that parses to the defaults and refuses to overwrite", async () => {
    const h = harness();
    let r = await h.run("policy", "init");
    expect(r.code).toBe(0);
    const text = readFileSync(join(h.home, ".merge-safely.yml"), "utf8");
    expect(text).toContain("# Merge Safely policy");
    const parsed = parsePolicy(parse(text));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.policy).toEqual(DEFAULT_POLICY);
    r = await h.run("policy", "init");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [POLICY_EXISTS]");
  });
});

describe("policy lint", () => {
  it("reports schema errors (including nested typos) with exit 1", async () => {
    const h = harness();
    writeFileSync(join(h.home, ".merge-safely.yml"), "tiers:\n  criticalPath: ['x']\n");
    const r = await h.run("policy", "lint");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error");
    expect(r.stdout).toMatch(/tiers/);
  });

  it("warns about connections that do not exist", async () => {
    const h = harness();
    writeFileSync(
      join(h.home, "p.yml"),
      "models:\n  hunters: { connection: nope, model: m }\npanel:\n  t1: { hunters: [correctness, made-up] }\n",
    );
    const r = await h.run("policy", "lint", "p.yml");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('connection "nope" does not exist');
    expect(r.stdout).toContain('unknown lens "made-up"');
    expect(r.stdout).toContain("ok");
  });

  it("is a pure function too", () => {
    expect(lintPolicy(POLICY_TEMPLATE, "t", []).errors).toEqual([]);
    expect(lintPolicy("a: [", "bad.yml", []).errors[0]).toContain("not valid YAML");
    expect(lintPolicy("version: 2", "v.yml", undefined).errors.length).toBeGreaterThan(0);
  });

  it("errors when the file is missing", async () => {
    const r = await harness().run("policy", "lint");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("POLICY_NOT_FOUND");
  });
});
