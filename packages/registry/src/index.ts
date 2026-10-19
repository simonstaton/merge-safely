// @merge-safely/registry — versioned, data-only model registry with pricing (design 7.2, 7.6).

/** Re-exported from core so the CLI can hand the exact same normaliser to seating (`findInCatalog`). */
export { normaliseModelId } from "@merge-safely/core";
export {
  cheaperModel,
  describeModel,
  familyOf,
  findModel,
  ladderFor,
  modelsFor,
  tierRank,
} from "./lookup.js";
export { MODELS, REGISTRY_VERSION } from "./models.js";
export { pessimisticPricing, priceUsage, withPricing } from "./pricing.js";
