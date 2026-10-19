import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_ID, getPersona, listPersonas, PERSONA_IDS, resolvePersona } from "./personas.js";

describe("personas", () => {
  it("ships the four personas with skeptical-senior as default", () => {
    expect(PERSONA_IDS).toEqual(["skeptical-senior", "incident-postmortem", "red-team", "new-maintainer"]);
    expect(DEFAULT_PERSONA_ID).toBe("skeptical-senior");
    expect(resolvePersona(undefined).id).toBe("skeptical-senior");
    for (const p of listPersonas()) expect(getPersona(p.id)?.fragment.length).toBeGreaterThan(50);
  });

  it("returns undefined from getPersona and throws from resolvePersona for unknown ids", () => {
    expect(getPersona("nope")).toBeUndefined();
    expect(() => resolvePersona("nope")).toThrow(/Known personas/);
  });
});
