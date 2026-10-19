// @merge-safely/registry — versioned, data-only model registry with pricing (design 7.2, 7.6).

export {
  cheaperModel,
  describeModel,
  findModel,
  ladderFor,
  modelsFor,
  normaliseModelId,
  tierRank,
} from "./lookup.js";
export { MODELS, REGISTRY_VERSION } from "./models.js";
export { pessimisticPricing, priceUsage, withPricing } from "./pricing.js";
