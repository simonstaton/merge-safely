import type { ChangedFile, LensId, ModelTierClass, PersonaId, Tier } from "@merge-safely/core";

/** A changed file as a lens sees it: trusted metadata, path already flattened to one safe line. */
export interface LensFileInfo {
  path: string;
  previousPath?: string;
  status: ChangedFile["status"];
  additions: number;
  deletions: number;
}

/**
 * What a lens's `focus` may look at. Deliberately excludes every untrusted field (title, body,
 * comments, diff text) so a lens checklist can never interpolate attacker-controlled prose.
 */
export interface LensPromptInput {
  files: readonly LensFileInfo[];
  tier: Tier;
  round: number;
  diffIsDelta: boolean;
  allowedCommands: readonly string[];
  hasLinkedTicket: boolean;
  knownFindingCount: number;
}

export interface Lens {
  /** kebab-case, unique in the registry. */
  id: LensId;
  title: string;
  /** The one question this lens answers. */
  question: string;
  /** kebab-case finding classes this lens typically emits. Unique within the lens. */
  classes: readonly string[];
  preferredModelTier?: ModelTierClass;
  /** True when the lens only applies to some changes (e.g. UI); the panel decides whether to seat it. */
  conditional?: boolean;
  /** Render the lens-specific investigation checklist. Pure; must not throw. */
  focus(input: LensPromptInput): string;
}

export interface Persona {
  id: PersonaId;
  title: string;
  /** System-prompt flavour text. Trusted, authored in this package or by the installer. */
  fragment: string;
}

export interface PromptOptions {
  persona?: PersonaId;
  /** Runner-supplied description of the tools it exposes. Trusted. Defaults to a generic description. */
  toolsDescription?: string;
  /** Rendered as "round N of max" when given. */
  maxRounds?: number;
  /** In delta mode, the previously reviewed SHA the delta is computed from. */
  deltaSinceSha?: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}
