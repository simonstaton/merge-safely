import type { Lens } from "../types.js";
import { commandHint, FLAG_CONFIG_PATH, focusBlock, MIGRATION_PATH, pathsMatching, startWith } from "./helpers.js";

export const rolloutLens: Lens = {
  id: "rollout",
  title: "Rollout safety",
  question: "Flags, migrations, backfills, data volume, rollback path. Does the flag exist in production?",
  classes: [
    "missing-flag",
    "unflagged-enable",
    "flag-default-on",
    "unbatched-backfill",
    "irreversible-migration",
    "blocking-migration",
    "deploy-order",
    "no-rollback",
  ],
  preferredModelTier: "mid",
  focus: (input) => {
    const migrations = pathsMatching(input, MIGRATION_PATH);
    const config = pathsMatching(input, FLAG_CONFIG_PATH);
    return focusBlock({
      tools:
        "grep for every flag key and read where it is defined and defaulted per environment (production config, flag definitions, env files, IaC); read each migration and the model code that uses it; use git log to see how earlier migrations and flags in this repo were shipped.",
      checks: [
        "Flags: is new risky behaviour behind a flag? Does that flag exist in production configuration, and what is its production default? A flag that only exists in dev or test config means the code is on or off in production by accident.",
        "Flag removal or default flip: is the old path still needed by anything, and has the flag actually been fully on in production?",
        "Migrations: is each one reversible (a working down migration or a documented forward fix)? Dropping or renaming a column or table that running code still reads is a blocker.",
        "Locking: will the migration rewrite or lock a large table (adding non-null columns with defaults, type changes, index creation without a concurrent option)?",
        "Backfills: is the backfill batched, resumable and throttled, or one statement over the whole table? Is it idempotent if re-run?",
        "Data volume: estimate the rows or objects touched from schema, fixtures, comments or prior migrations, and say how you estimated it.",
        "Deploy order: can old code run against the new schema, and new code against the old, during a rolling deploy?",
        "Rollback: if this is reverted an hour after deploy, what breaks? Data written in the new shape, deleted data, consumed messages.",
        commandHint(input, "check migration status or dry-run output"),
      ],
      hints: [...startWith("Migrations changed", migrations), ...startWith("Config or flag files changed", config)],
      evidence:
        "the flag definition or its absence per environment (file:line or the grep that found nothing), the migration file:line, and the volume estimate with its source.",
    });
  },
};
