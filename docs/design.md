# Technical Design: Merge Safely, an Agnostic, Adversarial AI Code Review Gate for GitHub

Status: draft v0.3, 19 October 2026 (v0.2 renamed from the `review-gate` placeholder to Merge Safely)
Author: Simon Staton (design drafted with Claude from the Fanbot codebase and Anthropic's published approach)
Project name: Merge Safely. Handle `merge-safely` everywhere: GitHub org and repo (`merge-safely/merge-safely`), GitHub App slug, npm scope `@merge-safely`, check name `merge-safely/verdict`. Checked free on all four on 19 October 2026; `mergesafely` also free and worth registering as a guard.

---

## 1. Purpose

An open source GitHub integration, built on a pure embeddable library, that turns "an AI reviewed this PR" into a verifiable, commit-pinned merge signal that any merge bot or human can gate on. It runs on the GitHub side of the workflow, so it works regardless of what tool wrote the code: Claude Code, Orca, Cursor, Codex, a human in vim. The end user brings their own model credentials and pays their own model bill. The project never proxies tokens or holds a model budget on anyone's behalf.

It encodes the review discipline a senior engineer applies by hand (understand intent, decide how you would do it, see how they did it, go down to code level, attack it adversarially) and runs it on every change, scaled to the risk of the change rather than the seniority of the author.

It is extracted from the merge-gate pipeline in Fanbot, which already has risk-scaled quorums, reviewer archetypes, SHA-bound verdicts, proof-of-work on passes, triage, and a multi-provider credential model. It drops the parts of Fanbot nobody adopted (the agent fleet, the workers, the authoring UI) and keeps the parts that proved themselves. It aligns with how Anthropic describe running review on their own codebase: review on every PR, tier set by the change, approvals tied to a commit, findings that block, a round cap, and evidence-driven loosening.

### Design principles

1. **Pure core, thin edges.** The decision logic has zero I/O. Everything that touches a VCS, a model, a filesystem or a network is a port with swappable adapters.
2. **Runs where the PR is.** The default deployments are a GitHub Action and a GitHub App. Nobody has to install a tool, switch editors or open a dashboard to be reviewed.
3. **Bring your own model, pay your own bill.** Credentials belong to the installing user or org. Anthropic, OpenAI, Gemini, OpenAI-compatible endpoints, cloud-hosted models and local models are all connections. Connecting one takes a minute.
4. **The change sets the tier, not the author.** Risk is computed from paths, size and blast radius. Author trust only decides who may bypass and where escalations go, never how hard the review is.
5. **Verdicts are facts about a commit.** A verdict is bound to a head SHA. A new push invalidates it. There is no such thing as approving a PR.
6. **A pass must be earned.** A reviewer that did not read anything cannot pass anything. Proof of work is attested by the runner, not self-reported by the model.
7. **Findings are the product.** Style-only findings are dropped. Everything else is deduplicated, severity-ranked, and rendered where the author already is: the PR.
8. **Converge or escalate.** Bounded rounds, diff-only re-review after the first pass, never repeat a finding. When the loop does not converge, a human gets a pre-digested queue, not a diff.
9. **Untrusted input everywhere.** PR titles, bodies, diffs and comments are data, never instructions. Reviewers run with read-only tools in a disposable workspace.
10. **Start strict, loosen with evidence.** Ship conservative defaults and the metrics needed to justify relaxing them.

### Non-goals

- Not an authoring tool, IDE, or agent fleet. It never writes code.
- Not a merge bot. It emits a signal that merge bots (Mergify, GitHub merge queue, rulesets) consume.
- Not a replacement for CI. It assumes tests and linters already run elsewhere and reads their status.
- Not a model reseller. No shared keys, no hosted inference, no markup. Hosted convenience, if it ever exists, is still bring-your-own-key.
- Not a business. Free, open source, a tool in the pipeline. Suggested licence: Apache 2.0, so companies can run it in private pipelines and contribute adapters without AGPL questions (PR-Agent moved back to Apache 2.0 for the same reason). No telemetry or phone-home by default. The eval suite and the incident template are the project's asset; contributions of anonymised incident cases are how it gets better.

---

## 2. What is carried over, and from where

| Concept | Origin | Carried over as |
|---|---|---|
| Risk-scaled quorum, critical-path floor, one block fails all | Fanbot `review-quorum`, `review-complexity` | `tiering/` and `quorum/` in core, policy-driven |
| Reviewer archetypes, personas, lenses, rubric, verdict JSON schema | Fanbot `review-personas`, `shared/agent-archetypes`, `templates/red-team-review` | `lenses/` with a lens registry and prompt builders |
| SHA-bound verdict store, atomic write, no-downgrade guard | Fanbot `review-verdict-store` | `VerdictStore` port with compare-and-set semantics |
| Proof of work on pass verdicts | Fanbot `review-proof-of-work`, hooks timeline | Runner-attested `ToolUseAudit` in the `ReviewerRun` result |
| Deterministic triage of tiny, non-critical diffs | Fanbot `review-triage`, `review-docs-only` | `triage/` stage |
| Cascade seating, decorrelated models per seat | Fanbot `review-cascade-seating`, `review-effective-lenses` | `panel/` stage |
| Bounded rounds, per-attempt caps, stall watchdog | Fanbot coordinator | `rounds/` with a cap of 3 by default |
| Human sign-off hold | Fanbot `signoff-request-store` | `Escalation` port, fires after AI review, keyed on tier not author kind |
| Four mutually exclusive model auth modes, model registry with capability flags, per-repo reviewer model override | Fanbot auth modes, `models.ts`, `repo-gate-store.reviewerModel` | `ModelProvider` port, connection kinds, model registry (section 7) |
| Streamed cost ledger (SQLite WAL, compaction), pricing table with cache rates and pessimistic fallback, zero-cost models | Fanbot `cost-tracker`, `usage-tracker`, `models.ts` | `CostLedger` port and `registry/` pricing (section 7.6) |
| Rolling-window ceiling, all-time limit against own ledger, per-agent ceiling, edge-triggered alerts, admission-time evaluation | Fanbot `budget-ceiling`, `fleet-spend`, `spend-limit-pause`, `per-agent-spend-ceiling` | Four ceilings in `core/budget`, evaluated at admission and on a tick |
| Budget-cap exit classified as a resumable pause, not a crash | Fanbot `budget-cap-exit`, `budget-cap-pause-signal` | Runner status `budget-exceeded` with recovery text in the digest |
| Plan-window monitoring for subscription auth, 429 backoff honouring Retry-After | Fanbot `subscription-usage-monitor`, `claude-usage` | Subscription connection kind, window thresholds, overage refusal |
| Ceiling persistence with null-vs-zero semantics restored at boot | Fanbot `restore-budget-ceiling` | App settings store |
| Severity tags Important, Nit, Pre-existing; drop style-only | Anthropic | Finding schema and aggregation rules |
| Multi-agent find then vote | Anthropic, Fanbot adversarial critic | Two-phase panel: hunters then judges |
| Diff-only re-review, no repeat findings, class-of-bug flag | Anthropic convergence fixes | `FindingFingerprint`, round delta input |
| Approvals pinned to commit, agent approval never counts as human | Anthropic | Verdict kind field: `machine` vs `human`, both SHA-bound |
| Trusted authors get the light path, others need a second person | Anthropic | `TrustProvider` port, used only for bypass and escalation routing |
| Review on every PR, continuously, like spellcheck | Anthropic | Pre-PR local mode and GitHub mode share one pipeline |
| Incident-derived eval set, known-clean false-positive runs | Anthropic | `evals/` package and `Metrics` port |

Two Fanbot rules are deliberately **not** carried over as they stand:

- The independence rule that rejects verdicts for `external:` authors. It protected a fleet from approving its own work. With human authors and machine reviewers the threat is inverted. The new rule is: a reviewer may not be the same principal as the author, and a verdict's authority never depends on who the author is.
- The control-plane-only enrollment scope. Enrollment is a policy decision on the change and the author's trust, evaluated per webhook event, not a registry of PRs the system itself created.

Two documentation mismatches found in Fanbot become explicit policy: the critical quorum constant is two, not three as the doc says, and triage is deterministic, not a model call. Both become configurable with honest defaults.

---

## 3. Domain model

All types live in `@merge-safely/core` and are plain data. No methods, no I/O.

```ts
// A change under review. Produced by a SourceProvider adapter.
interface Change {
  repo: RepoRef;                 // { host: "github.com", owner, name }
  number: number;                // PR / MR number
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  title: string;                 // untrusted
  body: string;                  // untrusted
  author: Principal;             // { kind: "human" | "bot" | "agent", login, id? }
  files: ChangedFile[];          // { path, status, additions, deletions }
  stats: { additions: number; deletions: number; files: number };
  labels: string[];
  draft: boolean;
  ciStatus: "pending" | "success" | "failure" | "unknown";
  linkedTicket?: TicketRef;      // optional; fed to the intent lens
}

// Risk classification. Computed by tiering, never supplied by the author.
interface Tier {
  level: 0 | 1 | 2 | 3;          // 0 trivial, 1 standard, 2 elevated, 3 critical
  score: number;                 // 0..100 composite
  factors: {
    loc: number; files: number; modules: number;
    criticalPathHits: string[]; // matched patterns
    blastRadius?: number;        // optional adapter-supplied signal (importers count etc.)
  };
  reasons: string[];             // human readable
}

// A reviewer seat in the panel.
interface Seat {
  lens: LensId;                  // e.g. "intent", "correctness", "repro", "security", "design-fidelity", "perf", "rollout"
  persona?: PersonaId;           // optional system-prompt flavour
  model: ModelRef;               // { connectionId, provider, name, effort? } — decorrelated across seats
  role: "hunter" | "judge";      // two-phase panel
  budget: { maxTurns: number; maxUsd?: number; deadlineMs: number };
}

// What a reviewer run must return. Enforced by JSON schema at the runner.
interface ReviewerOutput {
  verdict: "pass" | "block";
  summary: string;
  findings: Finding[];
  confidenceRefuted?: string[];  // claims in the PR body the reviewer disproved
}

interface Finding {
  id: string;                    // fingerprint: hash(path, normalised line window, class)
  severity: "blocker" | "important" | "nit" | "pre-existing";
  class: string;                 // e.g. "symptom-fix", "n-plus-one", "stale-approval", "missing-flag", "lock-risk"
  title: string;
  detail: string;
  file?: string; line?: number; endLine?: number;
  evidence?: string[];           // commands run, files read, measurements
  suggestedFix?: string;
}

// Runner-attested proof of work. The model does not write this.
interface ToolUseAudit {
  substantiveCalls: number;      // reads, greps, diffs, test runs
  filesRead: string[];
  commandsRun: string[];
  tokens: { in: number; out: number };
  costUsd?: number;              // from the model registry's pricing, when known
  wallMs: number;
}

interface ReviewerRun {
  seat: Seat;
  headSha: string;
  output: ReviewerOutput | null; // null if the run failed or timed out
  audit: ToolUseAudit;
  status: "ok" | "timeout" | "error" | "schema-invalid" | "budget-exceeded";
}

// SHA-bound result of aggregating a round.
interface Verdict {
  repo: RepoRef; number: number; headSha: string;
  kind: "machine" | "human";     // human verdicts come from the Escalation port
  decision: "pass" | "block" | "pending";
  tier: Tier;
  round: number;
  seats: ReviewerRun[];          // full provenance
  findings: Finding[];           // aggregated, deduplicated, ranked
  quorum: { required: number; passed: number; blocked: number };
  cost: { usd?: number; tokens: { in: number; out: number } };
  createdAt: string; expiresAt?: string;
  policyHash: string;            // the policy that produced it
}
```

---

## 4. Architecture

Hexagonal. One core, seven ports, many adapters. The core exposes a single orchestrator plus the pure stage functions for people who want to compose their own pipeline.

```
                 ┌────────────────────────────────────────────┐
  SourceProvider │                 core                        │  Reporter
  (GitHub, GitLab│  intake → tier → triage → seat → run* →     │  (check run, PR review,
   local git)  ─►│  aggregate → verdict → report → rounds      │─► Slack, stdout, JSON)
                 │                                             │
  ModelProvider ─►│  * run is the only stage that calls a port  │─► VerdictStore
  (Anthropic,    │    during execution; everything else is     │   (fs, sqlite, postgres, KV,
   OpenAI/Codex, │    pure given its inputs                    │    check-run-backed)
   Gemini, OpenAI│                                             │
   -compatible,  │                                             │─► Escalation
   Bedrock/Vertex│                                             │   (sign-off queue, Slack, Linear)
   local)        │                                             │
                 │                                             │─► Metrics
  Workspace    ─►│                                             │   (OTel, Prometheus, stdout)
  (Actions       └────────────────────────────────────────────┘
   runner,                     ▲
   container,            TrustProvider
   remote sandbox)  (GitHub teams, allowlist, CODEOWNERS)
```

### 4.1 Ports

```ts
interface SourceProvider {
  getChange(ref: ChangeRef): Promise<Change>;
  getDiff(ref: ChangeRef, opts?: { sinceSha?: string }): Promise<string>;   // full or delta
  listOpenChanges?(repo: RepoRef): AsyncIterable<ChangeRef>;               // optional, for polling mode
}

interface Workspace {
  // Provide a read-only checkout of headSha. Must be disposable and isolated per seat.
  acquire(change: Change): Promise<WorkspaceHandle>;                        // { cwd, dispose() }
}

// A connected model backend. See section 7.
interface ModelProvider {
  id: ProviderId;                                                            // "anthropic" | "openai" | "gemini" | "openai-compatible" | "bedrock" | "vertex" | "azure-openai" | "ollama" | ...
  connectionKinds: ConnectionKind[];                                         // which credential shapes it accepts
  validate(conn: Connection): Promise<ValidationResult>;                    // cheap health check + model list
  models(conn: Connection): Promise<ModelInfo[]>;                           // from the registry, filtered by what this key can reach
  createRunner(conn: Connection, model: ModelInfo): ModelRunner;
}

interface ModelRunner {
  // Run one seat. Must enforce the JSON schema, read-only tools and the budget,
  // and must produce the ToolUseAudit itself from what it observed.
  run(seat: Seat, input: ReviewerInput, ws: WorkspaceHandle): Promise<ReviewerRun>;
}

interface VerdictStore {
  get(key: VerdictKey): Promise<Verdict | null>;                            // key = repo+number+headSha
  // Compare-and-set so a later "pass" cannot overwrite an unresolved independent "block".
  put(v: Verdict, expect: { version: string | null }): Promise<{ ok: boolean; version: string }>;
  listForChange(repo: RepoRef, number: number): Promise<Verdict[]>;
}

interface Reporter {
  report(event: ReportEvent): Promise<void>;   // pending | verdict | escalated | error | budget-blocked
}

interface TrustProvider {
  // Used ONLY for bypass and escalation routing. Never changes the tier.
  classify(author: Principal, repo: RepoRef): Promise<"trusted" | "standard" | "blocked">;
}

interface Escalation {
  request(v: Verdict, digest: HumanDigest): Promise<EscalationHandle>;
  resolve?(handle: EscalationHandle): Promise<Verdict | null>;             // human verdict, SHA-bound
}

interface Metrics { emit(m: MetricEvent): void; }
```

### 4.2 Pipeline stages

Each stage is an exported pure function. The orchestrator wires them.

1. **Intake.** Normalise the change. Quarantine untrusted text into `untrusted.*` fields that only reach prompts inside delimited data blocks.
2. **Tiering.** `tier(change, policy)`. Composite score from LOC, file count, module spread, critical-path pattern hits and optional blast radius. A critical-path hit forces level 3 regardless of score. Patterns are per-repo policy, with a vetted default that matches whole path segments, not substrings, so "author" does not match "auth".
3. **Triage.** `triage(change, tier, policy)`. Tier 0 only. Docs-only, assets-only, lockfile-only, or under size thresholds with no critical hit. Returns `auto-pass` (a verdict with zero seats and `triaged: true`) or `review`.
4. **Seating.** `seat(tier, policy, connections)`. Chooses lens set, seat count, models and whether a judge phase runs. Picks models from the installation's connected providers, decorrelating across providers when more than one is connected. Fails loudly if policy asks for a model the installation cannot reach.
5. **Budget check.** `budget(seats, policy, spend)`. Estimated cost of the panel against per-change and per-installation ceilings. Over budget: downgrade models per policy, or block with a `budget-blocked` report that tells the user exactly what to raise.
6. **Run.** `ModelRunner.run` per seat, concurrently, each in a fresh context and its own workspace handle. The runner must: pass the rubric and lens prompt, pass untrusted PR text as data, allow only read tools (optionally an allowlisted test command), enforce the JSON schema, kill on budget, and record the `ToolUseAudit` from its own observation of tool calls.
7. **Proof of work.** `attest(run, policy)`. A `pass` with too few substantive calls or an empty `filesRead` is downgraded to `schema-invalid` and does not count toward quorum. Blocks are never discarded for lack of work; they go to the judge phase.
8. **Judge phase.** Judges receive the hunters' findings and the diff, and vote per finding: `confirm`, `refute`, `downgrade`. A finding survives if confirmations meet `policy.judgeAgreement`. Style-only classes are dropped here.
9. **Aggregate.** Deduplicate by fingerprint, rank by severity then class, compute quorum. One surviving `blocker` is a block regardless of quorum. Pass requires `passed >= required`, which scales with tier and has a floor of 2 at tier 3.
10. **Verdict.** Build the `Verdict`, compare-and-set into the store. If a stored block exists for the same SHA with unresolved findings, a new pass is rejected and the round is marked `contested`.
11. **Report.** Emit `pending` at intake, `verdict` at the end, with the digest and the cost line. Reporters decide rendering.
12. **Rounds.** On a new push: compute the delta diff since the last reviewed SHA, pass prior findings as `known`, instruct hunters not to repeat known findings and to check whether each was addressed. Cap at `policy.maxRounds` (default 3). After the cap, or at tier 3 by default for non-trusted authors, call `Escalation.request` with the digest.

### 4.3 Human digest

The thing a human reads instead of the diff. Rendered in the check run summary, the PR review body, and escalation messages.

```
Verdict: BLOCK (tier 3, round 2 of 3)                                 cost $1.84 · 3 seats · 2m 10s
Why tier 3: touches packages/plasma/queries/*Raw.ts and fanguard/src/jobs/** (critical paths)
Quorum: 2 required, 1 passed, 2 blocked

Blockers (1)
  [lock-risk] Backfill scans tracking_link_period without batching — fanguard/src/jobs/growth/backfill…Job.ts:41
     Evidence: ran EXPLAIN on the raw query; seq scan, no LIMIT, inside one transaction.
     Suggested: batch by creator_id ranges of 1000 with a sleep, commit per batch.

Important (2) … Nits (3) … Pre-existing (1)

Addressed since round 1: 4 of 6 findings. Not addressed: #f3a9, #c17e.
Reviewer effort: 41 files read, 12 commands.
```

---

## 5. Policy

Policy is a versioned, hashed document in the consuming repo. The hash is stored on every verdict so any verdict traces to the rules that produced it. Everything has a conservative default so a repo can start with an empty file.

```yaml
# .merge-safely.yml
version: 1

tiers:
  thresholds: { t1: 20, t2: 50, t3: 80 }
  criticalPaths:                              # whole-segment matchers, per repo
    - "**/migrations/**"
    - "**/schema.prisma"
    - "**/jobs/**/backfill*"
    - "**/queries/**/*Raw.ts"
    - "eden/src/layouts/**"
    - "src/layouts/AppShell/**"
    - "**/auth/**"
    - "**/payments/**"
    - ".github/workflows/**"
  flagRemovalIsCritical: true                 # diffs that delete a feature-flag read are tier 3

triage:
  maxLines: 30
  maxFiles: 3
  docsOnlyAutoPass: true

panel:
  t1: { hunters: [correctness, repro], judges: 1 }
  t2: { hunters: [intent, correctness, repro, design-fidelity], judges: 2 }
  t3: { hunters: [intent, correctness, repro, security, perf, rollout, blast-radius], judges: 2, secondJudgeRound: true }

models:                                       # names refer to connections made in the installation (section 7)
  hunters:  { connection: anthropic-main, model: claude-sonnet-5-5 }
  judges:   { connection: anthropic-main, model: claude-opus-5-5 }
  fallback: { connection: openai-main,    model: gpt-5 }          # used when the primary is rate limited or down
  decorrelate: true                           # alternate connections across hunters when more than one is connected

quorum:
  t1: 1
  t2: 2
  t3: 2                                       # floor; one blocker still fails everything
  judgeAgreement: 0.6
  dropClasses: [style, formatting, naming-preference]

proofOfWork:
  minSubstantiveCalls: 3
  requireFilesRead: true

rounds:
  max: 3
  diffOnlyAfterRound: 1
  neverRepeatFindings: true

trust:
  provider: github-teams
  trusted: ["fanvue/developers"]              # may bypass for tiers 0-2; never changes tiers
  trustedBypassMaxTier: 2
  escalateTier3ForStandardAuthors: true

reporting:
  checkName: "merge-safely/verdict"
  postPrReview: true
  inlineComments: true
  showCostInSummary: true

budget:
  perSeatUsd: 5
  perChangeUsd: 25
  perInstallationMonthlyUsd: 500              # enforced by the App; the Action reads it as advisory
  onOverBudget: downgrade-then-block          # or: block
```

---

## 6. Where it runs

Two GitHub-side deployments share one pipeline. Both put the model bill on the installing user.

### 6.1 GitHub Action (zero infrastructure)

```yaml
# .github/workflows/merge-safely.yml
on: { pull_request: { types: [opened, synchronize, reopened, ready_for_review] } }
permissions: { checks: write, pull-requests: write, contents: read }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: merge-safely/action@v0
        with:
          connections: |
            anthropic-main: { provider: anthropic, apiKey: ${{ secrets.ANTHROPIC_API_KEY }} }
            openai-main:    { provider: openai,    apiKey: ${{ secrets.OPENAI_API_KEY }} }
```

Runs on the user's Actions minutes against the user's model keys held in GitHub secrets. Checks out the head SHA, runs the pipeline in-process, writes the check run and the PR review. The verdict store is the check run itself plus a workflow artifact, so rounds work without a database. Good for a single repo or a team trying it out.

Limits: Actions cold start adds a minute, no per-installation budget enforcement across repos, no escalation queue beyond a Slack webhook, and `pull_request_target` from forks needs the usual care.

### 6.2 GitHub App (the real integration)

A small service that receives `pull_request`, `push` and `check_suite` webhooks, enqueues work, runs seats in disposable containers or a remote sandbox, and writes check runs and PR reviews. It is the Fanbot control plane minus the fleet and the authoring UI.

It is designed to be **self-hosted by the installing org** with one-click deploy templates (Docker Compose, Fly, Railway, Vercel with a queue, AWS with a container service). The maintainers do not run a shared instance in v0. A hosted convenience instance is possible later and would still be bring-your-own-key with per-installation encryption, but it adds custody of other people's credentials, which the project should not take on until it has to.

What the App adds over the Action: sub-minute latency, cross-repo policy, a durable store, per-installation budgets, an escalation queue with a human-verdict path, decorrelation across several connected providers, and a tiny setup web page for connections (section 7.4).

### 6.3 CLI

```
merge-safely connect anthropic              # interactive: pick kind, paste or OAuth, validate, save
merge-safely connect openai --api-key-env OPENAI_API_KEY
merge-safely connect openai-compatible --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY
merge-safely connections list | test | remove <id>
merge-safely run --repo fanvue/pandora --pr 39180
merge-safely run --local                    # review the working tree vs base, pre-PR "spellcheck" mode, no store
merge-safely explain --pr 39180             # print the digest for the latest verdict
merge-safely estimate --pr 39180            # tier, seats, model choice, estimated cost, without running
merge-safely policy lint
merge-safely eval --suite incidents/
```

`--local` is the Anthropic "review while you write" loop: same lenses, same connections file, output to stdout. It is how non-engineers get the deep review before they open a PR, from whatever authoring tool they use.

### 6.4 Programmatic

```ts
import { createGate } from "@merge-safely/core";
import { github } from "@merge-safely/github";
import { anthropic, openai } from "@merge-safely/providers";
import { containerWorkspace } from "@merge-safely/workspace-docker";
import { postgres } from "@merge-safely/store-postgres";

const gate = createGate({
  source: github({ app }),
  providers: [anthropic(), openai()],
  connections: await loadConnections(installationId),   // encrypted at rest, see 7.5
  workspace: containerWorkspace(),
  store: postgres(url),
  reporters: [github.checkRun(), github.prReview()],
  trust: github.teams(),
  policy,
});

const verdict = await gate.review({ repo, number: 39180 });
```

### 6.5 Merge-bot wiring

The gate never merges. It publishes a check run per head SHA with pending, success and failure states. Consumers gate on it:

- **Mergify:** add `check-success = merge-safely/verdict` to queue conditions, replacing "no human comments means merge".
- **GitHub rulesets:** require the check; express trusted-team bypass with bypass actors, mirroring `trust.trustedBypassMaxTier`.
- **GitHub merge queue:** same required check.
- **Anything else:** read the verdict JSON from the store API.

Because the check is SHA-bound, a push after a green verdict flips it back to pending automatically. That closes the stale-approval hole without any extra rule.

---

## 7. Provider connections (bring your own model)

This is the part that decides whether anyone outside the maintainer ever installs it. Connecting a model has to be a one-minute task, and the project must never be in the money path.

### 7.1 Connection kinds

Modelled on Fanbot's four mutually exclusive auth modes, generalised so an installation can hold several connections at once.

| Kind | Providers | Shape | Notes |
|---|---|---|---|
| `api-key` | Anthropic, OpenAI, Gemini, Mistral, Groq, others | `{ apiKey }` | The default. Validated by a models-list call or a one-token completion. |
| `openai-compatible` | OpenRouter, Together, Fireworks, vLLM, Ollama, LM Studio, any gateway | `{ baseUrl, apiKey?, headers? }` | Covers nearly everything that is not a first-party SDK. This is how Fanbot's OpenRouter mode worked (base URL + token). |
| `anthropic-compatible` | Any gateway speaking the Anthropic Messages API | `{ baseUrl, apiKey }` | Needed for the Claude Code CLI runner behind a proxy. |
| `oauth` | Anthropic Console OAuth; GitHub Models; others as they appear | `{ accessToken, refreshToken, expiresAt }` | Browser flow from the setup page or `connect`. Refresh handled by the provider adapter. |
| `cloud` | AWS Bedrock, Google Vertex, Azure OpenAI | `{ region, projectOrResource, credentialsRef }` | Uses the ambient cloud identity of the runner or an OIDC federation. Nothing long-lived stored. |
| `subscription` | Claude subscription via the Claude Code login | `{ credentialFileRef }` | Fanbot supported this. Keep it as an opt-in, clearly documented as "your personal login, your terms", default off. Automated use of a consumer subscription is a terms-of-service question the installing user owns, not the project. |

A connection record is `{ id, provider, kind, label, createdBy, createdAt, lastValidatedAt, scopes?, defaultModel? }` plus an encrypted secret blob. The `id` is what policy refers to.

### 7.2 Model registry

A versioned, data-only registry (like Fanbot's `models.ts`) of known models with the fields the pipeline needs:

```ts
interface ModelInfo {
  provider: ProviderId; name: string;
  supportsTools: boolean; supportsStructuredOutput: boolean;
  contextTokens: number; maxOutputTokens: number;
  pricing?: { inPerMTok: number; outPerMTok: number; cachedInPerMTok?: number };
  tier: "small" | "mid" | "frontier";       // used for decorrelation and downgrade ladders
  effortLevels?: string[];
}
```

Providers may extend it at runtime from their models endpoint. Pricing drives the `estimate` command, the cost line in the digest, and budget enforcement. Unknown models are allowed with `pricing: undefined` and a warning that budgets cannot be enforced for them.

### 7.3 Runners per connection

- **Anthropic.** Two runners. The Messages API runner with a built-in read-only tool set (read, list, grep, git) executed by the runner process, which also produces the audit. And the Claude Code CLI runner, print mode, JSON schema, allowlisted tools, with the audit built from `stream-json` tool_use events. The CLI runner gives the richest investigation and is the recommended default when the CLI is available on the runner image.
- **OpenAI, including Codex.** The Responses API runner with the same built-in tool set, and optionally the Codex CLI in non-interactive mode where present. Function-calling plus JSON schema output.
- **Gemini.** Generative API runner with function calling and the built-in tool set.
- **OpenAI-compatible and Anthropic-compatible.** Reuse the API runners with a base URL. Capability flags come from the registry or are probed once at connection time.
- **Cloud.** Thin wrappers over the provider SDKs with cloud credentials; same tool set.
- **Local.** OpenAI-compatible endpoint; registry marks tool support per model.

All runners share one tool implementation so proof-of-work semantics are identical across providers. The model never executes tools itself; the runner does, in the workspace, and records what it did.

### 7.4 Connecting: the user experience

Target: under a minute from "installed the App" to "first review ran".

- **Action users:** add a secret, reference it in the workflow. The Action validates the key on first run and writes a clear check run failure if it is wrong, with the exact fix.
- **App users:** after GitHub's install redirect, a single setup page lists providers with the connection kinds each supports. Paste a key or click an OAuth button, pick a default model, see the estimated cost per tier for a typical PR, save. The page calls `validate` immediately and shows the models that key can reach.
- **CLI users:** `merge-safely connect <provider>` walks through the same steps and writes the connections file.

Every surface shows the same three facts before the first run: which models will be used per tier, estimated cost per PR, and the budget ceiling. Nobody should be surprised by a bill.

### 7.5 Credential custody

- **Action:** no custody. Keys live in GitHub secrets and are only in memory during the job.
- **Self-hosted App:** envelope encryption. A per-installation data key wraps each secret blob; the data key is wrapped by a master key from the host's KMS or an environment variable for small deployments. Secrets are never logged, never returned by any API after creation, and are redacted from all error output. Rotation is a re-connect.
- **Scoping:** a connection belongs to an installation (org or repo set). Policy in a repo can only reference connections of its installation.
- **Validation and health:** every connection is re-validated on a schedule and before a tier 3 panel. A failing connection marks seats `error` rather than silently skipping them, and the check run says which connection failed.
- **Fallback:** policy may name a fallback connection used on provider outage or rate limiting, so a Codex key can cover an Anthropic incident and vice versa. Fallback use is recorded on the verdict.

### 7.6 Cost accounting and budgets

The user pays the model bill, so the gate has to be the thing that stops a bad night from becoming an invoice. This section carries over Fanbot's spend machinery, most of which exists because of a specific incident, and adapts it from "agents in a fleet" to "seats in a review".

**Ledger, not estimate.** Cost is recorded as streamed deltas from the runner's usage events as they arrive, not computed once at the end. A seat that is killed at a deadline has still been paid for, and the ledger shows it. The ledger is a `CostLedger` port with a SQLite default (WAL mode, local disk only, periodic truncate checkpoint, aged rows compacted into per-change rollups so sums stay exact and the table stays bounded). Postgres adapter for the App. Every row carries connection, provider, model, change, head SHA, seat and lens, so cost can be sliced by any of them.

**Pricing with a pessimistic fallback.** The registry carries input, output, cache-write and cache-read rates per model. A model the registry does not know is priced at the maximum of every known rate rather than left unpriced, so budgets always enforce and the only way to be wrong is to over-estimate. Zero-cost models (local, or plan-included under a subscription connection) are flagged explicitly so they neither trip ceilings nor hide behind them.

**Four ceilings, each fail-safe and each resettable.**

| Ceiling | Scope | Default | On breach |
|---|---|---|---|
| Per seat | one reviewer run | `maxTurns` 50, `perSeatUsd` 5, deadline 10 min | seat ends `budget-exceeded`, excluded from quorum, never counts as a pass |
| Per change | one PR across all rounds | `perChangeUsd` 25 | downgrade ladder, then block with the exact ceiling named |
| Rolling window | the installation over a window of at most 7 days | `windowUsd` unset | new reviews refused at admission; in-flight seats finish |
| All-time | the installation, against the gate's own ledger | `spendLimitUsd` unset | same as rolling window |

The all-time ceiling is evaluated against the gate's own ledger, never against the provider's account usage. Fanbot learned this with OpenRouter: the provider figure is the key's lifetime spend, cannot be reset by the tool, and made any key with prior usage permanently over limit. Provider usage is display-only in the setup page and the digest. Enforcement uses numbers the user can clear.

**Admission, not execution, is where ceilings bite.** Ceilings are checked when a review is about to be seated, and again on a periodic tick, never only when someone opens a UI. Fanbot's all-time pause once fired only inside a summary endpoint, so with no one watching the dashboard it never fired at all. The Action evaluates at job start. The App evaluates at webhook intake and on a timer.

**Edge-triggered alerts.** Threshold alerts (50, 80, 100 percent of any ceiling) fire once per crossing and re-arm only when spend drops back below, so a ceiling held at 101 percent does not page every minute. Same latch pattern for the rolling-window and all-time breaches.

**A budget stop is a pause, not a crash.** When a runner stops a seat because the model process hit its own budget flag, the process exits non-zero, which on the wire looks identical to a crash. Fanbot had an operator recreate an agent from scratch because of this, losing its context. The runner classifies the exit from the signals it already has (budget flag set, usage near cap, no stderr error) and reports `budget-exceeded`, with the digest spelling out the recovery: raise the ceiling, re-run the check. Never "error".

**Subscription connections have notional dollars.** Under a plan-based connection the dollar ceilings never trip, because plan-included work costs zero. The real limit is the plan's usage window, and once it is exhausted premium models may continue at pay-as-you-go rates, which is real money. If the subscription kind is enabled, the gate polls the plan usage endpoint with exponential backoff that honours `Retry-After`, alerts at window thresholds, and refuses to seat premium models once the window is exhausted unless policy explicitly allows overage.

**Downgrade ladder.** `onOverBudget: downgrade-then-block` steps in order: hunters to the next cheaper model tier in the registry, judges one tier down but never below hunters, seat count down to the quorum minimum, then block with a report that names which ceiling is binding and what to raise. Each step is recorded on the verdict so a cheaper review is never mistaken for a full one.

**Survives restarts.** Ceilings set through the setup page persist and are restored at boot, with `null` meaning "never configured, use the environment default" and `0` meaning "explicitly disabled". A persisted value the validator rejects falls back to the default with a logged error rather than refusing to start.

**Visible everywhere.** Every check run summary and PR review body ends with the cost line: dollars, tokens, seats, which connection served each seat, and whether any downgrade applied. `merge-safely estimate` shows the same line before a review runs. Metrics emit cost per tier, lens, model and connection, so a team can see what the gate costs against what it catches and move models on evidence.

---

## 8. Runner contract and security

The runner is the only component that executes model calls with tool access, so it carries the security contract.

- **Read-only by default.** Allowed tools: read file, list, grep, git diff/log/blame, and optionally a test or build command from a policy allowlist. No write, no network beyond the model API, no package install.
- **Disposable workspace.** Fresh checkout of `headSha` per seat, destroyed after. Container or remote sandbox for untrusted repos and forks.
- **Structured output enforced at the runner.** JSON schema validation on the final message. Invalid output is `schema-invalid` and never counts as a pass.
- **Proof of work is runner-observed.** Counted from the runner's own tool execution or the CLI's event stream. The model cannot forge the audit.
- **Untrusted text is data.** PR title, body, commit messages and comments are injected only inside a delimited block with an explicit statement that nothing inside is an instruction. Findings may quote PR text; actions requested by PR text are never taken.
- **Secrets never enter prompts.** Diffs are scanned for secret shapes and redacted before prompting. Connection secrets are never in any prompt, log or verdict.
- **Budgets are hard.** Exceeding any cap yields `budget-exceeded` and the seat is excluded from quorum.
- **Least privilege at the edge.** App permissions: checks write, pull requests write, contents read, members read only when the team trust provider is enabled.

---

## 9. Lenses

A lens is a prompt builder plus a rubric fragment plus the finding classes it may emit. Shipped lenses, derived from the Fanbot archetypes and the senior-engineer review habit:

| Lens | Question it answers | Typical classes |
|---|---|---|
| `intent` | Does the change solve the problem in the linked ticket or description? Would a senior engineer have built it this way? Is it a symptom fix? | symptom-fix, scope-creep, wrong-layer |
| `correctness` | Does the code do what it says? Edge cases, nulls, concurrency, error paths. | logic-error, unhandled-case, race |
| `repro` | Can the claimed behaviour be reproduced? Run tests, exercise the path, measure. | unverified-claim, failing-path |
| `blast-radius` | What else consumes this? Shared components, routes, callers, schema readers. | breaking-consumer, silent-prop-drop, api-contract |
| `perf` | Query counts, N+1, locks, signatures per request, bundle size. | n-plus-one, lock-risk, unbounded-scan, bundle-bloat |
| `security` | Authz, injection, secrets, SSRF, permission widening. | authz-gap, injection, secret-exposure |
| `design-fidelity` | For UI: match to the referenced design, tokens, a11y, RTL, reduced motion. | a11y, token-drift, layout-regression |
| `rollout` | Flags, migrations, backfills, data volume, rollback path. Does the flag exist in production? | missing-flag, unflagged-enable, unbatched-backfill, no-rollback |

Lens authors export `{ id, prompt(input), rubric, classes, preferredModelTier? }`. Third parties publish lenses as packages. Policy picks them per tier.

---

## 10. Observability, evals and loosening

The only honest answer to "do we need this much review" is a number, so the library ships the measurements.

**Metrics per change:** tier, triaged, seats, rounds, time to verdict, cost by connection; findings by severity and class; addressed versus carried; pass after one round; changes needing five or more rounds; author response per finding where observable (fixed, rejected-as-wrong, intentional, doesnt-matter); escalations and human outcomes; optional post-merge join of reverts and incidents by tier and trust class.

**Evals:** `merge-safely eval` runs the pipeline against past changes with known outcomes. Incident-derived cases should block; known-clean cases should pass. Reports recall and false-block rate per lens and per model, so model choices can be made on evidence rather than brand. The suite grows with every incident and the CLI has a template for adding one.

**Circuit breakers:** if the false-block rate on known-clean exceeds a threshold, widen triage and alert. If reverts in a tier exceed a threshold, raise that tier's quorum until reviewed.

---

## 11. Package layout

Monorepo, TypeScript, ESM. No vendor SDK in core.

```
packages/
  core/                  domain types, stages, orchestrator, policy schema, fingerprints, budget       (pure)
  lenses/                shipped lens set and prompt builders                                          (pure)
  registry/              model registry data and pricing                                              (pure)
  providers/             ModelProvider port + connection kinds + encrypted connection store interface   (pure)
  provider-anthropic/    Messages API runner + Claude Code CLI runner + Console OAuth
  provider-openai/       Responses API runner + optional Codex CLI runner
  provider-gemini/
  provider-compatible/   openai-compatible and anthropic-compatible base-URL runners
  provider-cloud/        Bedrock, Vertex, Azure OpenAI
  tools/                 the shared read-only tool implementation and audit used by every API runner
  github/                SourceProvider, Reporter (check run, PR review), TrustProvider (teams), webhook verifier, App auth
  gitlab/                later
  workspace-local/  workspace-docker/  workspace-sandbox/
  store-memory/  store-checkrun/  store-fs/  store-sqlite/  store-postgres/
  escalation-slack/  escalation-linear/
  metrics-otel/
  cli/                   merge-safely binary, including `connect`
  action/                GitHub Action wrapper around cli
  app/                   self-hosted GitHub App service: webhooks, queue, setup page, encrypted connections
  evals/                 suite format, runner, reporters
examples/
  action-minimal/  app-docker-compose/  app-fly/  mergify/  rulesets/  local-precommit/
```

---

## 12. Mapping from Fanbot

For the extraction itself. Line counts are approximate and from the current repo.

| Fanbot module | Destination | Change needed |
|---|---|---|
| `review-coordinator/coordinator.ts` (~1900) | `core/orchestrator` | Remove fleet-semantic return values (`destroyed`, `system-reap`); replace deps with the ports |
| `review-coordinator/types.ts` | `core/types` | Split `ReviewCoordinatorDeps` into ports |
| `review-quorum.ts`, `review-complexity.ts` | `core/tiering`, `core/quorum` | Segment matcher for critical paths; quorum constants become policy |
| `review-triage.ts`, `review-docs-only.ts` | `core/triage` | Policy wiring only |
| `review-personas.ts`, `review-effective-lenses.ts`, `review-cascade-seating.ts` | `lenses/`, `core/panel` | Remove store imports at module load; implement the declared-but-inert `author-in` as a trust check |
| `shared/agent-archetypes.ts`, `templates/red-team-review.ts` | `lenses/` | Split rubric from spawn config; add untrusted-text delimiting |
| `models.ts`, auth modes, `reviewerModel` override | `registry/`, `providers/`, `provider-*` | Generalise four exclusive modes into many concurrent connections; keep the mode shapes |
| `cost-tracker.ts`, `usage-tracker.ts` pricing, `models.ts` zero-cost flag | `core/budget`, `CostLedger` port, `registry/` | Keep streamed deltas, WAL ledger, compaction and pessimistic fallback pricing; re-key rows from agent to change, SHA, seat and lens |
| `budget-ceiling.ts`, `fleet-spend.ts`, `spend-limit-pause.ts`, `per-agent-spend-ceiling.ts` | `core/budget` ceilings | Pure evaluators move unchanged; fleet pause callback becomes admission refusal; per-agent ceiling becomes per-seat and per-change |
| `budget-cap-exit.ts`, `budget-cap-pause-signal.ts` | runner exit classification | Pure classifier moves unchanged; pause reason text becomes digest recovery text |
| `subscription-usage-monitor.ts`, `claude-usage.ts` | `provider-anthropic` subscription kind | Keep polling, backoff and threshold logic; drop the fleet sidebar rendering |
| `restore-budget-ceiling.ts` | `app` settings | Moves unchanged |
| `review-proof-of-work.ts` + hooks timeline | `tools/` audit, `provider-anthropic` CLI runner | Rebuild as runner-observed; drop the single-control-plane assumption |
| `review-verdict-store.ts` | `store-*` behind `VerdictStore` | Compare-and-set; drop `external:` independence rule; remove `gh` call from `writeVerdict` |
| `review-adapters/reviewer-lifecycle.ts`, `review-workspace-pool*`, `process-manager`, `workspace-manager` | `provider-*` runners, `workspace-*` | Rewrite: no fleet, no pool, process per seat |
| `review-adapters/verdict-delivery.ts` | `github` Reporter + `escalation-*` | Rewrite: message bus becomes PR review and escalation |
| `review-enrollment-policy.ts`, `review-request-store.ts` | `core/policy` + `TrustProvider` | Replace registry scope with per-event policy on change and trust |
| `signoff-request-store.ts` | `Escalation` port | Fire after review, key on tier and trust, SHA-bound human verdict |
| `github-app.ts` | `github` App auth | Keep; request explicit permissions |
| `merge-gate/*`, `merge-shepherd.ts` | Not carried | Merging is the consumer's job; the check run is the signal |

---

## 13. Roadmap

**v0.1, usable alone**
GitHub Action; Anthropic provider with both runners; OpenAI provider with the API runner; openai-compatible provider; shared tool set and audit; check-run-backed store; check run and PR review reporters; tiering, triage, single-round panel with judges, proof of work; policy with defaults; CLI `connect`, `run`, `--local`, `estimate`.

**v0.2, the App**
Self-hosted GitHub App with webhooks, queue, setup page and encrypted connections; rounds with diff-only re-review and fingerprints; team trust provider; escalation to Slack and Linear; sqlite and postgres stores; per-installation budgets; Mergify and rulesets examples; Gemini and cloud providers.

**v0.3, evidence**
Metrics port with OTel adapter; eval suite format and runner; incident template; circuit-breaker hooks; per-model eval reports.

**v1.0**
Stable policy schema and port interfaces; GitLab adapter; container and remote sandbox workspaces; published lens packaging guide.

---

## 14. Open questions

1. **Test execution in reviewers.** It gives the `repro` lens teeth but widens the sandbox requirement. Default off, allowlist per repo?
2. **Judge model choice.** Judges should be stronger than hunters, but cost scales with tier. Is "same model, fresh context, adversarial prompt" enough at tier 1?
3. **Human verdicts.** Should a human approval through the Escalation port override a machine block, or only resolve an escalation? Anthropic's "a person is accountable for every change" argues for override with provenance.
4. **Hosted instance.** Worth offering a maintainer-run App with bring-your-own-key, or is credential custody a liability the project should refuse indefinitely?
5. **Subscription connections.** Keep the Claude subscription kind at all, given the terms question, or document it as a community adapter outside the main repo?
6. **Blast radius signal.** Importer and route counts are repo-specific. Optional `BlastRadiusProvider` port, or leave it to lens prompts?
7. **Pre-existing findings.** Nightly scans of existing code are the same pipeline with a synthetic change. A `scan` command in v0.3?
8. **Stacked PRs.** Treat the stack as one change for tiering and review each layer separately?

---

## Appendix A: the week that motivated this

Five production-bound changes in one week in one repo, all authored by non-engineers using AI tools, none caught by process:

- A 35-file UI redesign auto-merged with zero human review twelve minutes before its author asked for one.
- A feature enabled at 100 percent for every creator by a commit pushed after the only approval, merged on that stale approval.
- A feature flag removed in code but never created in production, flooding error tracking past plan limits.
- A backfill that locked production tables for hours.
- A shared layout rebuild that would have silently dropped 22 props across 120 routes, caught only because that one repository required an owner.

Every one of them is a tiering failure or a stale-approval failure. None is a "not enough people reading diffs" failure. That is the problem this project is for.

## Appendix B: sources

- Fanbot merge-gate design and code: `docs/merge-gate.md`, `src/review-*`, `src/review-coordinator/`, `src/templates/red-team-review.ts`, `src/shared/agent-archetypes.ts`, `src/models.ts`, `src/github-app.ts`, fleet auth modes in `CLAUDE.md`
- Anthropic, "Solving code review at Anthropic", claude.dev blog, 2026
