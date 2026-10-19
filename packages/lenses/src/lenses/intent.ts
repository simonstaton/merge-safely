import type { Lens } from "../types.js";
import { focusBlock } from "./helpers.js";

export const intentLens: Lens = {
  id: "intent",
  title: "Intent",
  question:
    "Does the change solve the problem in the linked ticket or description, at the right layer, the way a senior " +
    "engineer would have built it, or is it a symptom fix?",
  classes: ["symptom-fix", "scope-creep", "wrong-layer", "misread-requirement", "incomplete-fix", "reinvented-utility"],
  preferredModelTier: "frontier",
  focus: (input) =>
    focusBlock({
      tools:
        "read the changed files and the code around the bug, grep for the failing behaviour and for existing helpers, " +
        "use git log and git blame on the touched lines to learn why the code was the way it was.",
      checks: [
        `State the problem in one sentence from the ${input.hasLinkedTicket ? "linked ticket and the " : ""}PR text, then confirm it against the code; the description may be wrong.`,
        "Before reading the diff closely, decide how you would fix it. Compare: where the approaches differ, find out which is right.",
        "Symptom versus root cause: does the change remove the cause, or catch, clamp, retry, special-case or hide the symptom while the cause still fires elsewhere?",
        "Find every other path that hits the same root cause (grep the call sites); a fix on one path only is an incomplete fix.",
        "Wrong layer: is the fix in the UI when the data is wrong, in a caller when the callee is wrong, or a guard where a type or constraint belongs?",
        "Scope creep: list changes unrelated to the stated problem. Unrelated behaviour changes riding along are findings; unrelated refactors are only findings if they carry risk.",
        "Reinvention: does the codebase already have a helper, pattern or library for this? Cite it.",
        "Would a senior engineer who owns this module have built it this way? If not, name the concrete cost of the chosen design, not a preference.",
      ],
      evidence:
        "the root-cause location (file:line), the alternative path or existing helper you found, and the git history that supports your reading.",
    }),
};
