import type { ChangedFile, LensId, ModelTierClass, PersonaId, ReviewerInput, Tier } from "@merge-safely/core";

/** What the prompt builders read. The `prompt` field is their output, so it is not required as input. */
export type ReviewerPromptInput = Omit<ReviewerInput, "prompt">;

/**
 * A changed file as a lens sees it. Paths are author-controlled, so `path` is hard-sanitised to
 * `[A-Za-z0-9._/@+-]` (anything else becomes `?`) and `exact` says whether that left it unchanged.
 * Lens hints should only name files where `exact` is true; the exact list lives in the changed-files block.
 */
export interface LensFileInfo {
  path: string;
  exact: boolean;
  previousPath?: string;
  status: ChangedFile["status"];
  additions: number;
  deletions: number;
}

/**
 * What a lens's `focus` may look at. Excludes every free-text untrusted field (title, body, comments, diff, ticket)
 * and carries file paths only in sanitised form, so a lens checklist cannot interpolate attacker-written prose.
 */
export interface LensPromptInput {
  files: readonly LensFileInfo[];
  tier: Tier;
  round: number;
  diffIsDelta: boolean;
  allowedCommands: readonly string[];
  /** True only when ticket text is actually rendered in the prompt. */
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
  /** Untrusted-block nonce, `[a-z0-9]{6,32}`. Defaults to a crypto-random value per prompt; pin it in tests. */
  nonce?: string;
  /** Diff size cap in chars (default 200k). Longer diffs are cut with a [truncated N chars] note. */
  maxDiffChars?: number;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** The nonce used for this prompt's untrusted blocks, for leak checks. */
  nonce: string;
  /** Finding ids exactly as rendered (judges: the candidates to vote on, after dropping unsafe ids and duplicates). */
  findingIds: string[];
  /** Non-fatal problems, e.g. candidates dropped for unsafe or duplicate ids. */
  warnings: string[];
}
