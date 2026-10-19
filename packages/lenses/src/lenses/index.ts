import type { Lens } from "../types.js";
import { blastRadiusLens } from "./blast-radius.js";
import { correctnessLens } from "./correctness.js";
import { designFidelityLens } from "./design-fidelity.js";
import { intentLens } from "./intent.js";
import { perfLens } from "./perf.js";
import { reproLens } from "./repro.js";
import { rolloutLens } from "./rollout.js";
import { securityLens } from "./security.js";

export {
  blastRadiusLens,
  correctnessLens,
  designFidelityLens,
  intentLens,
  perfLens,
  reproLens,
  rolloutLens,
  securityLens,
};

/** The eight shipped lenses, in design-doc order. */
export const BUILTIN_LENSES: readonly Lens[] = [
  intentLens,
  correctnessLens,
  reproLens,
  blastRadiusLens,
  perfLens,
  securityLens,
  designFidelityLens,
  rolloutLens,
];
