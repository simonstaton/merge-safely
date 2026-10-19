// @merge-safely/store-memory — In-memory VerdictStore and CostLedger

export {
  type CostLedgerFactory,
  costLedgerContract,
  type VerdictStoreFactory,
  verdictStoreContract,
} from "./contract.js";
export { FIXTURE_REPO, fakeClock, makeCostEntry, makeVerdict } from "./fixtures.js";
export { memoryCostLedger, memoryVerdictStore } from "./memory.js";
