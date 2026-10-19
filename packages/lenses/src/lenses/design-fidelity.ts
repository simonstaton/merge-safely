import type { Lens } from "../types.js";
import { focusBlock, pathsMatching, startWith, UI_PATH } from "./helpers.js";

export const designFidelityLens: Lens = {
  id: "design-fidelity",
  title: "Design fidelity",
  question: "For UI: does it match the referenced design, tokens, accessibility, RTL and reduced motion?",
  classes: [
    "a11y",
    "token-drift",
    "layout-regression",
    "design-mismatch",
    "rtl-break",
    "motion-sensitivity",
    "missing-state",
  ],
  preferredModelTier: "mid",
  conditional: true,
  focus: (input) =>
    focusBlock({
      tools:
        "read the changed components and their styles, grep for the design-system tokens and components the codebase already uses, read sibling components for the established pattern, read any linked design spec in the repo.",
      checks: [
        "Tokens: hard-coded colours, spacing, radii, font sizes or z-indexes where a design token or theme value exists. Cite the token.",
        "Components: hand-rolled buttons, inputs, modals or menus where the design system already provides one.",
        "Accessibility: semantic elements, labels and names for controls, keyboard reachability and focus order, focus visibility, contrast, alt text, ARIA used correctly or not at all.",
        "States: loading, empty, error, disabled and overflow states for every new view; long strings and translations.",
        "Layout: responsive breakpoints, RTL (use logical properties, not left/right), and shared components whose layout change hits other screens.",
        "Motion: animations respect prefers-reduced-motion.",
        "If the PR references a design, check the implementation against what is actually in the repo or ticket; do not assume what the design says.",
      ],
      hints: startWith("UI files changed", pathsMatching(input, UI_PATH)),
      evidence:
        "the component file:line, the token or system component that should have been used, and the user-visible effect.",
    }),
};
