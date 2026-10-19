import { z } from "zod";

/**
 * Policy schema for `.merge-safely.yml`. Every field has a conservative default so an empty file is valid.
 * The parsed policy is hashed and the hash is stored on every verdict.
 */

export const LENS_IDS = [
  "intent",
  "correctness",
  "repro",
  "blast-radius",
  "perf",
  "security",
  "design-fidelity",
  "rollout",
] as const;

export const DEFAULT_CRITICAL_PATHS = [
  "**/migrations/**",
  "**/migration/**",
  "**/schema.prisma",
  "**/*.sql",
  "**/jobs/**/backfill*",
  "**/backfill*/**",
  "**/queries/**/*Raw.*",
  "**/auth/**",
  "**/authz/**",
  "**/permissions/**",
  "**/payments/**",
  "**/billing/**",
  "**/payouts/**",
  "**/webhooks/**",
  "**/crypto/**",
  "**/secrets/**",
  ".github/workflows/**",
  "**/Dockerfile",
  "**/docker-compose*.yml",
  "**/infra/**",
  "**/terraform/**",
  "**/*.tf",
  "**/layouts/**",
];

const modelSelection = z.object({
  connection: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().optional(),
});
export type ModelSelection = z.infer<typeof modelSelection>;

const panelTier = z.object({
  hunters: z.array(z.string().min(1)).min(1),
  judges: z.number().int().min(0).max(5).default(1),
  secondJudgeRound: z.boolean().default(false),
});
export type PanelTierPolicy = z.infer<typeof panelTier>;

export const policySchema = z
  .object({
    version: z.literal(1).default(1),

    tiers: z
      .object({
        thresholds: z
          .object({
            t1: z.number().min(0).max(100).default(20),
            t2: z.number().min(0).max(100).default(50),
            t3: z.number().min(0).max(100).default(80),
          })
          .default({}),
        criticalPaths: z.array(z.string()).default(DEFAULT_CRITICAL_PATHS),
        /** Diffs that delete a feature-flag read are tier 3. */
        flagRemovalIsCritical: z.boolean().default(true),
        /** Regexes (source form) that identify a feature-flag read in removed lines. */
        flagReadPatterns: z
          .array(z.string())
          .default([
            "\\b(isEnabled|isFeatureEnabled|useFlag|useFeatureFlag|getFlag|featureFlag|flags?\\.(get|is)\\w*|unleash\\.isEnabled|posthog\\.isFeatureEnabled|ldClient\\.variation)\\s*\\(",
          ]),
        /** Paths ignored entirely for size scoring (generated code, vendored, lockfiles). */
        ignorePaths: z
          .array(z.string())
          .default([
            "**/package-lock.json",
            "**/pnpm-lock.yaml",
            "**/yarn.lock",
            "**/*.snap",
            "**/dist/**",
            "**/vendor/**",
            "**/generated/**",
          ]),
      })
      .default({}),

    triage: z
      .object({
        maxLines: z.number().int().min(0).default(30),
        maxFiles: z.number().int().min(0).default(3),
        docsOnlyAutoPass: z.boolean().default(true),
        assetsOnlyAutoPass: z.boolean().default(true),
        lockfileOnlyAutoPass: z.boolean().default(true),
        docsPatterns: z
          .array(z.string())
          .default(["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "docs/**", "**/LICENSE*", "**/CHANGELOG*"]),
        assetPatterns: z
          .array(z.string())
          .default([
            "**/*.png",
            "**/*.jpg",
            "**/*.jpeg",
            "**/*.gif",
            "**/*.svg",
            "**/*.webp",
            "**/*.ico",
            "**/*.woff",
            "**/*.woff2",
            "**/*.ttf",
            "**/*.mp4",
          ]),
        lockfilePatterns: z
          .array(z.string())
          .default([
            "**/package-lock.json",
            "**/pnpm-lock.yaml",
            "**/yarn.lock",
            "**/Cargo.lock",
            "**/poetry.lock",
            "**/go.sum",
          ]),
      })
      .default({}),

    panel: z
      .object({
        t1: panelTier.default({ hunters: ["correctness", "repro"], judges: 1 }),
        t2: panelTier.default({ hunters: ["intent", "correctness", "repro", "design-fidelity"], judges: 2 }),
        t3: panelTier.default({
          hunters: ["intent", "correctness", "repro", "security", "perf", "rollout", "blast-radius"],
          judges: 2,
          secondJudgeRound: true,
        }),
        /** Lenses listed here are only seated when the change touches UI-looking paths. */
        conditionalLenses: z.record(z.string(), z.array(z.string())).default({
          "design-fidelity": [
            "**/*.tsx",
            "**/*.jsx",
            "**/*.vue",
            "**/*.svelte",
            "**/*.css",
            "**/*.scss",
            "**/components/**",
            "**/ui/**",
          ],
        }),
      })
      .default({}),

    models: z
      .object({
        hunters: modelSelection.optional(),
        judges: modelSelection.optional(),
        fallback: modelSelection.optional(),
        decorrelate: z.boolean().default(true),
        /** Per-lens override, e.g. { security: { connection, model } }. */
        perLens: z.record(z.string(), modelSelection).default({}),
      })
      .default({}),

    quorum: z
      .object({
        t1: z.number().int().min(1).default(1),
        t2: z.number().int().min(1).default(2),
        t3: z.number().int().min(2).default(2),
        judgeAgreement: z.number().min(0).max(1).default(0.6),
        dropClasses: z
          .array(z.string())
          .default(["style", "formatting", "naming-preference", "comment-style", "whitespace"]),
      })
      .default({}),

    proofOfWork: z
      .object({
        minSubstantiveCalls: z.number().int().min(0).default(3),
        requireFilesRead: z.boolean().default(true),
      })
      .default({}),

    rounds: z
      .object({
        max: z.number().int().min(1).default(3),
        diffOnlyAfterRound: z.number().int().min(0).default(1),
        neverRepeatFindings: z.boolean().default(true),
      })
      .default({}),

    trust: z
      .object({
        provider: z.enum(["none", "github-teams", "allowlist", "codeowners"]).default("none"),
        trusted: z.array(z.string()).default([]),
        blocked: z.array(z.string()).default([]),
        trustedBypassMaxTier: z.number().int().min(0).max(3).default(2),
        escalateTier3ForStandardAuthors: z.boolean().default(true),
        /** Treat bot/agent principals as standard (never trusted) regardless of allowlists. */
        botsAreStandard: z.boolean().default(true),
      })
      .default({}),

    reporting: z
      .object({
        checkName: z.string().default("merge-safely/verdict"),
        postPrReview: z.boolean().default(true),
        inlineComments: z.boolean().default(true),
        showCostInSummary: z.boolean().default(true),
        /** Request changes on block (true) or always comment-only (false). */
        requestChangesOnBlock: z.boolean().default(true),
      })
      .default({}),

    budget: z
      .object({
        perSeatUsd: z.number().min(0).default(5),
        perChangeUsd: z.number().min(0).default(25),
        perInstallationMonthlyUsd: z.number().min(0).nullable().default(null),
        windowUsd: z.number().min(0).nullable().default(null),
        windowDays: z.number().min(0).max(7).default(7),
        spendLimitUsd: z.number().min(0).nullable().default(null),
        onOverBudget: z.enum(["downgrade-then-block", "block"]).default("downgrade-then-block"),
        seatMaxTurns: z.number().int().min(1).default(50),
        seatDeadlineMs: z
          .number()
          .int()
          .min(1000)
          .default(10 * 60 * 1000),
        alertThresholds: z.array(z.number().min(0).max(2)).default([0.5, 0.8, 1.0]),
      })
      .default({}),

    runner: z
      .object({
        /** Commands reviewers may execute. Exact match by default; an entry ending in " *" allows extra arguments after that prefix (e.g. "npm test", "npx vitest run *"). Default: none. */
        allowedCommands: z.array(z.string()).default([]),
        commandTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .default(5 * 60 * 1000),
        maxToolOutputBytes: z
          .number()
          .int()
          .min(1024)
          .default(64 * 1024),
        /** Redact secret-looking strings from diffs and untrusted text before prompting. */
        redactSecrets: z.boolean().default(true),
      })
      .default({}),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;
