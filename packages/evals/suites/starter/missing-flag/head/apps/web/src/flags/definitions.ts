/**
 * Every flag the web app reads must be declared here AND created in the flag service for each environment.
 * The client logs an error for any name it cannot resolve.
 */
export const FLAGS = {
  "checkout-legacy-fallback": { owner: "payments-team", default: false },
  "search-v2": { owner: "discovery-team", default: false },
  "profile-badges": { owner: "creator-team", default: true },
} as const;

export type FlagName = keyof typeof FLAGS;
