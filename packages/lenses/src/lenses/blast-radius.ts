import type { Lens } from "../types.js";
import { focusBlock, removedPaths, startWith } from "./helpers.js";

export const blastRadiusLens: Lens = {
  id: "blast-radius",
  title: "Blast radius",
  question: "What else consumes this? Shared components, routes, callers, schema readers.",
  classes: [
    "breaking-consumer",
    "silent-prop-drop",
    "api-contract",
    "schema-reader-break",
    "route-break",
    "event-contract",
  ],
  preferredModelTier: "mid",
  focus: (input) =>
    focusBlock({
      tools:
        "grep the whole repository for every changed export, type, route, prop, column, event name and config key; read each consumer you find; use git log to spot consumers that changed recently.",
      checks: [
        "Enumerate every changed or removed public surface: exported functions and types, component props, HTTP routes and payloads, CLI flags, env vars, DB columns, queue or event schemas.",
        "For each, find every consumer (grep for the symbol, string literal and dynamic lookups), not only the ones the diff updated.",
        "Signature changes: new required parameters, changed return shape, narrowed types, sync to async, thrown versus returned errors.",
        "Prop drops: a prop or option removed or renamed while some callers still pass it, so it is now silently ignored.",
        "Shared code: a component, hook or util used by several features. Check each caller still gets the behaviour it relied on.",
        "Data readers: other services, jobs, analytics or reports that read a changed table, column, cache key or message format, including old code still running mid-deploy.",
        "Public API or SDK contract changes without versioning or deprecation.",
      ],
      hints: startWith("Removed or renamed (check nothing still imports them)", removedPaths(input)),
      evidence: "the consumer's file:line, the grep you ran to find it, and how that consumer now breaks.",
    }),
};
