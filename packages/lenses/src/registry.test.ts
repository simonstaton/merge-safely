import { LENS_IDS } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { makeInput } from "../test/fixture.js";
import { BUILTIN_LENSES } from "./lenses/index.js";
import { toLensPromptInput } from "./prompt.js";
import {
  createLensRegistry,
  getLens,
  isKebabCase,
  lensIds,
  lensRegistry,
  listLenses,
  validateLens,
} from "./registry.js";
import type { Lens } from "./types.js";

const thirdParty: Lens = {
  id: "i18n",
  title: "Internationalisation",
  question: "Are user-facing strings translatable?",
  classes: ["hard-coded-string"],
  focus: () => "1. grep for string literals in JSX",
};

describe("registry", () => {
  it("resolves every LENS_ID from the core policy schema", () => {
    for (const id of LENS_IDS) expect(getLens(id)?.id).toBe(id);
    expect(lensIds()).toEqual([...LENS_IDS]);
    expect(listLenses()).toHaveLength(8);
    expect(lensRegistry.requireLens("rollout").id).toBe("rollout");
  });

  it("throws on unknown ids with the known list", () => {
    expect(() => lensRegistry.requireLens("nope")).toThrow(/Known lenses: intent/);
  });

  it("registers third-party lenses and refuses duplicates unless replace is set", () => {
    const reg = createLensRegistry();
    reg.registerLens(thirdParty);
    expect(reg.getLens("i18n")?.title).toBe("Internationalisation");
    expect(() => reg.registerLens(thirdParty)).toThrow(/already registered/);
    reg.registerLens({ ...thirdParty, title: "i18n v2" }, { replace: true });
    expect(reg.getLens("i18n")?.title).toBe("i18n v2");
    expect(getLens("i18n")).toBeUndefined();
  });

  it("rejects malformed lenses", () => {
    const reg = createLensRegistry([]);
    expect(() => reg.registerLens({ ...thirdParty, id: "Bad Id" })).toThrow(/kebab-case/);
    expect(() => reg.registerLens({ ...thirdParty, classes: ["ok", "ok"] })).toThrow(/listed twice/);
    expect(() => reg.registerLens({ ...thirdParty, classes: ["NotKebab"] })).toThrow(/kebab-case/);
    expect(() => reg.registerLens({ ...thirdParty, classes: [] })).toThrow(/non-empty/);
  });
});

describe("shipped lenses", () => {
  it("are valid, with unique kebab-case classes, disjoint across lenses", () => {
    const all = new Map<string, string>();
    for (const lens of BUILTIN_LENSES) {
      expect(validateLens(lens)).toEqual([]);
      for (const c of lens.classes) {
        expect(isKebabCase(c)).toBe(true);
        expect(all.get(c), `${c} in ${lens.id} and ${all.get(c)}`).toBeUndefined();
        all.set(c, lens.id);
      }
    }
  });

  it("render a checklist that names tools and demands evidence", () => {
    const input = toLensPromptInput(makeInput());
    for (const lens of BUILTIN_LENSES) {
      const focus = lens.focus(input);
      expect(focus).toMatch(/^Tools: /);
      expect(focus).toContain("Checklist:\n1. ");
      expect(focus).toContain("Evidence per finding:");
    }
  });

  it("adapt to the change: rollout names migrations, blast-radius names removals, repro respects no commands", () => {
    const input = toLensPromptInput(makeInput());
    expect(getLens("rollout")?.focus(input)).toContain("Migrations changed: db/migrations/0042_add_coupon_index.sql.");
    expect(getLens("blast-radius")?.focus(input)).toContain("src/billing/legacy.ts");
    const noCmd = toLensPromptInput(makeInput({ allowedCommands: [] }));
    expect(getLens("repro")?.focus(noCmd)).toContain("no commands may be run");
    expect(getLens("correctness")?.focus(noCmd)).toContain("No commands may be run");
  });
});
