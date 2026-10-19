import type { Lens } from "../types.js";
import { focusBlock, pathsMatching, startWith, TEST_PATH } from "./helpers.js";

export const reproLens: Lens = {
  id: "repro",
  title: "Reproduction",
  question: "Can the claimed behaviour be reproduced? Run the tests, exercise the path, measure.",
  classes: ["unverified-claim", "failing-path", "test-gap", "vacuous-test", "flaky-test"],
  preferredModelTier: "mid",
  focus: (input) => {
    const canRun = input.allowedCommands.length > 0;
    return focusBlock({
      tools: canRun
        ? "run the allowed commands (only those), read the tests and fixtures, grep for the entry point that exercises the claimed path."
        : "no commands may be run: read the tests and fixtures and trace the claimed path by hand from its entry point.",
      checks: [
        "List each concrete behavioural claim in the PR text (fixes X, adds Y, no behaviour change, faster by N). Each is a hypothesis.",
        canRun
          ? "For each claim, run the narrowest allowed command that would prove or disprove it. Record the exact command and the relevant output lines."
          : "For each claim, find the test that proves it. If none exists, trace the code path and say what you could not verify.",
        "Do the new or changed tests assert the claimed behaviour, or only that the code runs? A test that passes against the old code proves nothing.",
        "Is the bug's original trigger covered by a regression test that fails without the fix?",
        "Paths the tests do not reach: error branches, alternate configs, other callers. Name the gap concretely.",
        "Flakiness: time, randomness, ordering, network or shared state in tests.",
        "List claims you disproved in confidenceRefuted.",
      ],
      hints: startWith("Changed tests", pathsMatching(input, TEST_PATH)),
      evidence: canRun
        ? "the command, its exit status and the output lines that matter; never paraphrase output you did not see."
        : "the test file:line or code path you traced, and what remains unverified.",
    });
  },
};
