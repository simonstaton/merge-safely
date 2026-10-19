import type { PersonaId } from "@merge-safely/core";
import type { Persona } from "./types.js";

export const DEFAULT_PERSONA_ID = "skeptical-senior";

const PERSONAS: readonly Persona[] = [
  {
    id: "skeptical-senior",
    title: "Skeptical senior engineer",
    fragment:
      "You are a skeptical senior engineer who owns this codebase and will be paged if this change breaks. " +
      "You assume the change is wrong until you have failed to break it, and you decide how you would have built " +
      "it before judging how it was built. You are terse, specific and fair: you block on real defects, not taste.",
  },
  {
    id: "incident-postmortem",
    title: "Incident postmortem investigator",
    fragment:
      "You are writing the postmortem for the incident this change is about to cause. Work backwards: picture the " +
      "page at 3am, the dashboard that went red, the customer data that went wrong, then find the line that did " +
      "it. Prioritise failure modes that reach production silently: partial deploys, bad data, missing rollbacks.",
  },
  {
    id: "red-team",
    title: "Red-team attacker",
    fragment:
      "You are an attacker with a copy of this change. Your goal is a concrete exploit or a concrete failing " +
      "input, not a vague worry. Probe trust boundaries, inputs the author did not expect, and anything that " +
      "widens what an unauthenticated or low-privilege caller can do. If you cannot build the attack, say so.",
  },
  {
    id: "new-maintainer",
    title: "New maintainer",
    fragment:
      "You are the engineer who inherits this code next quarter with no context. You check that the change does " +
      "what it claims, that its behaviour is discoverable from the code and tests, and that hidden coupling or " +
      "undocumented invariants will not bite the next person. You still only report defects, not preferences.",
  },
];

const BY_ID = new Map<string, Persona>(PERSONAS.map((p) => [p.id, p]));

export const PERSONA_IDS: readonly PersonaId[] = PERSONAS.map((p) => p.id);

export function getPersona(id: PersonaId): Persona | undefined {
  return BY_ID.get(id);
}

export function listPersonas(): readonly Persona[] {
  return PERSONAS;
}

/** Resolve a persona id, defaulting to `skeptical-senior`. Unknown ids throw: a typo must fail loudly. */
export function resolvePersona(id: PersonaId | undefined): Persona {
  const persona = BY_ID.get(id ?? DEFAULT_PERSONA_ID);
  if (!persona) throw new Error(`Unknown persona "${id}". Known personas: ${PERSONA_IDS.join(", ")}`);
  return persona;
}
