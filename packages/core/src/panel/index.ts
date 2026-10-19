// @merge-safely/core panel: the seating stage (lens set, seat count, model choice, decorrelation, fallback).
export { SeatingError } from "./errors.js";
export {
  describeSeating,
  findInCatalog,
  JUDGE_LENS,
  lensesFor,
  planFallback,
  type SeatingInput,
  type SeatingResult,
  seat,
  tierPanelKey,
} from "./seating.js";
