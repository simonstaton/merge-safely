import type { LensId } from "@merge-safely/core";
import { BUILTIN_LENSES } from "./lenses/index.js";
import type { Lens } from "./types.js";

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isKebabCase(s: string): boolean {
  return KEBAB.test(s);
}

/** Check a lens is well formed. Returns the problems found; empty means valid. */
export function validateLens(lens: Lens): string[] {
  const problems: string[] = [];
  if (typeof lens.id !== "string" || !isKebabCase(lens.id)) problems.push(`id "${String(lens.id)}" must be kebab-case`);
  if (!lens.title?.trim()) problems.push("title is required");
  if (!lens.question?.trim()) problems.push("question is required");
  if (typeof lens.focus !== "function") problems.push("focus must be a function");
  if (!Array.isArray(lens.classes) || lens.classes.length === 0) problems.push("classes must be a non-empty array");
  else {
    const seen = new Set<string>();
    for (const c of lens.classes) {
      if (!isKebabCase(c) || c.length > 64) problems.push(`class "${c}" must be kebab-case and at most 64 chars`);
      if (seen.has(c)) problems.push(`class "${c}" is listed twice`);
      seen.add(c);
    }
  }
  return problems;
}

export interface LensRegistry {
  getLens(id: LensId): Lens | undefined;
  /** Like getLens but throws with the known ids when missing. */
  requireLens(id: LensId): Lens;
  listLenses(): readonly Lens[];
  /** Register a third-party lens. Throws when invalid, or when the id is taken unless `replace` is set. */
  registerLens(lens: Lens, opts?: { replace?: boolean }): void;
  lensIds(): LensId[];
}

/** A fresh registry seeded with `seed` (the shipped lenses by default). Use for isolation in tests. */
export function createLensRegistry(seed: readonly Lens[] = BUILTIN_LENSES): LensRegistry {
  const lenses = new Map<LensId, Lens>();
  const register = (lens: Lens, opts?: { replace?: boolean }): void => {
    const problems = validateLens(lens);
    if (problems.length > 0) throw new Error(`Invalid lens "${String(lens.id)}": ${problems.join("; ")}`);
    if (lenses.has(lens.id) && !opts?.replace) throw new Error(`Lens "${lens.id}" is already registered`);
    lenses.set(lens.id, Object.freeze({ ...lens, classes: Object.freeze([...lens.classes]) }));
  };
  for (const lens of seed) register(lens);
  return {
    getLens: (id) => lenses.get(id),
    requireLens: (id) => {
      const lens = lenses.get(id);
      if (!lens) throw new Error(`Unknown lens "${id}". Known lenses: ${[...lenses.keys()].join(", ")}`);
      return lens;
    },
    listLenses: () => [...lenses.values()],
    registerLens: register,
    lensIds: () => [...lenses.keys()],
  };
}

/** The process-wide registry: shipped lenses plus anything registered at startup. */
export const lensRegistry: LensRegistry = createLensRegistry();

export const getLens = (id: LensId): Lens | undefined => lensRegistry.getLens(id);
export const requireLens = (id: LensId): Lens => lensRegistry.requireLens(id);
export const listLenses = (): readonly Lens[] => lensRegistry.listLenses();
export const registerLens = (lens: Lens, opts?: { replace?: boolean }): void => lensRegistry.registerLens(lens, opts);
export const lensIds = (): LensId[] => lensRegistry.lensIds();
