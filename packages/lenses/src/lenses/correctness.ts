import type { Lens } from "../types.js";
import { commandHint, focusBlock } from "./helpers.js";

export const correctnessLens: Lens = {
  id: "correctness",
  title: "Correctness",
  question: "Does the code do what it says? Edge cases, nulls, concurrency, error paths.",
  classes: ["logic-error", "unhandled-case", "null-handling", "race", "error-path", "resource-leak", "off-by-one"],
  preferredModelTier: "frontier",
  focus: (input) =>
    focusBlock({
      tools:
        "read each changed function in full along with the helpers it calls and their types, grep for its callers to learn real inputs, use git blame to see what invariants the old code kept.",
      checks: [
        "For each changed function, write down what correct means (inputs, outputs, side effects), then hunt for a concrete input that violates it.",
        "Boundaries: empty, one, many, zero, negative, max, unicode, duplicate, unsorted, missing optional fields, null versus undefined.",
        "Control flow: inverted conditions, wrong operator, early returns that skip cleanup, fallthrough, loops that never or always run, stale variables.",
        "Error paths: swallowed exceptions, errors converted to success, partial writes left behind, retries that are not idempotent, missing awaits, unhandled rejections.",
        "Concurrency: shared mutable state, check-then-act, ordering assumptions across async calls, double submission, cache invalidation races.",
        "Resources: handles, connections, timers, listeners and subscriptions that are opened but not closed on every path.",
        "Old versus new: anything the previous code handled that the new code silently stops handling.",
        "Tests: would they still pass if the implementation were reverted to a no-op? If yes, the behaviour is unverified.",
        commandHint(input, "exercise the failing input through the existing tests"),
      ],
      evidence: "file:line, the concrete failing input or trigger condition, and the expected versus actual behaviour.",
    }),
};
