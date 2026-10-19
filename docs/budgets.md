# Budgets and cost

You pay the model bill, so the gate has to be the thing that stops a bad night from becoming an invoice. Every dollar figure here is enforced against Merge Safely's own cost ledger, never against your provider's account usage.

## The ceilings

Five ceilings are evaluated against a proposed panel before anything runs:

| Ceiling | Scope | Policy key | Default | On breach |
|---|---|---|---|---|
| Per seat | One reviewer run | `budget.perSeatUsd`, `budget.seatMaxTurns`, `budget.seatDeadlineMs` | $5, 50 turns, 10 min | At admission: downgrade ladder, then refuse. While running: the seat ends `budget-exceeded` (or `timeout` at the deadline), is excluded from quorum, and never counts as a pass. |
| Per change | One PR across all rounds | `budget.perChangeUsd` | $25 | Downgrade ladder, then refuse, naming the ceiling. |
| Rolling window | The installation over the last `windowDays` days (at most 7) | `budget.windowUsd`, `budget.windowDays` | unset, 7 days | New reviews refused at admission. In-flight seats finish. |
| All-time | The installation, against the gate's own ledger | `budget.spendLimitUsd` | unset | Same as the rolling window. |
| Monthly | The installation over the last 30 days | `budget.perInstallationMonthlyUsd` | unset | Enforced by the App. Advisory in the Action and the CLI: reported, never blocking, because one job or machine cannot see spend across the whole installation. |

"The installation" is the App installation in the App. In the Action and the CLI's PR mode it is the repository (`owner/name`), and `run --local` uses one scope called `local`.

### In the GitHub Action

The Action enforces the per-seat and per-change ceilings. It treats the rolling-window, all-time and monthly ceilings as **advisory**: they are reported on the verdict and never block. Each Actions job starts with an empty ledger and cannot see spend from other jobs or repositories. Enforcing those ceilings there would compare one job's spend against an installation-wide limit, which fails open without saying so. When any of `budget.windowUsd`, `budget.spendLimitUsd` or `budget.perInstallationMonthlyUsd` is set, the Action logs one warning: "not enforceable in the Action: spend across jobs is not visible; use the App". For enforced installation-wide budgets, use the GitHub App, which keeps a shared ledger.

### Semantics

- `null` (or absent) means never configured. `0` means explicitly disabled. Neither ever breaches.
- A ceiling breaches when projected spend is strictly greater than the limit. Projected spend is what has already been spent in that scope plus the estimate for the panel about to run.
- Per-change spend is the larger of the ledger's figure and the sum of the costs on the change's stored verdicts, so the per-change ceiling holds across rounds even where the ledger is not persistent.
- **Fail closed.** If a ceiling is configured but its spend cannot be read (an embedder passed no ledger, or a ledger read failed or timed out), it counts as breached, and the message says a ledger is required.
- **Where the ledger lives.** The App's ledger is its SQLite database. The CLI's is `$MERGE_SAFELY_HOME/store` (or the SQLite database with `--store sqlite`), so window and all-time ceilings count what that machine spent. The Action uses the same file ledger on the runner, which on a GitHub-hosted runner starts empty on every job. That is why the Action treats window, all-time and monthly ceilings as advisory (see [In the GitHub Action](#in-the-github-action)). Use the App for installation-wide ceilings.
- When several ceilings breach, the binding one is reported in this order: all-time, window, monthly, per change, per seat.
- Installation-wide ceilings (window, all-time, monthly) refuse new reviews outright. A cheaper panel does not help the next PR.
- A budget refusal is not a review. It is never stored, uses no round, and does not replace a verdict already decided for the commit: the check stays pending (or keeps its earlier decision) until you raise the ceiling and re-run. The CLI exits 3.

### Where ceilings are checked

Every ceiling is checked at admission, when a review is about to be seated, on every surface. `merge-safely estimate` runs the same check without calling a model.

- The App also re-evaluates the installation ceilings at webhook intake, after each job and every minute, and alerts (see below). Its setup page and alerts measure the monthly figure over the calendar month (UTC); admission uses the last 30 days.

## The downgrade ladder

With `budget.onOverBudget: downgrade-then-block` (the default), a panel that would breach a ceiling steps down in order, re-checking every ceiling after each step and stopping as soon as nothing blocks:

1. **Hunters' model.** Every hunter moves one model tier down (frontier → mid → small) on the same connection.
2. **Judges' model.** Every judge moves one tier down, but never below the hunters' tier.
3. **Seat count.** Hunter seats are dropped down to the quorum minimum, lowest priority first. Priority, highest first: `correctness`, `security`, `intent`, `rollout`, `repro`, `perf`, `blast-radius`, `design-fidelity`. Unlisted (third-party) lenses are dropped before any of these.
4. **Refuse.** Still over budget. The report names the binding ceiling and the policy key to raise.

Judges never move below the hunters' tier, and the seat-count step never drops below the tier's quorum (and always keeps at least one hunter). Judge seats are never dropped.

Every step is recorded in the verdict's `downgrades`, and downgraded seats carry `downgradedFrom`, so a cheaper review is never mistaken for a full one.

With `budget.onOverBudget: block`, the panel is refused straight away.

A refusal reads like this:

```
Budget ceiling "per-change" would be exceeded: projected spend $27.40 ($19.10 already spent + $8.30 for this panel)
against a limit of $25.00. Raise budget.perChangeUsd in .merge-safely.yml, then re-run the check.
```

## A budget stop is a pause, not a crash

When a seat hits its turn or dollar cap, it ends `budget-exceeded`, never `error`. The digest spells out the recovery: raise the ceiling, re-run the check. Runners classify the exit from what they observed (the cap was reached, no stderr error), so a model process that exits non-zero because of its own budget flag is not reported as a crash.

## The cost line

Every digest (check run summary, PR review, CLI output) ends with a cost line unless `reporting.showCostInSummary: false`: dollars, tokens, seats and wall time, then which connection and model served each seat. Downgrades are listed just above it.

```
Cost: $1.84 · 212.4k tokens in / 18.9k out · 3 seats · 2m 10s
  Connections: hunter:correctness:1 → anthropic-main/claude-sonnet-5-5 $0.41; ...
```

The full breakdown is in the verdict's `cost`: total `usd`, `tokens`, and `bySeat` with the connection, model and dollars for each seat.

## Estimate before you run

```bash
merge-safely estimate --repo my-org/my-repo --pr 1234
merge-safely estimate --local
```

Prints the tier, the seats, the model for each seat, the estimated cost, every configured ceiling with its projected spend, the downgrade steps that would apply, and whether admission would run or refuse the review (exit 3). Nothing runs and nothing is billed. `merge-safely connect` and the App's setup page show the same three facts before the first run: which models each tier uses, the estimated cost of a typical 300-line PR, and the budget ceilings.

Estimates use a conservative per-seat token heuristic over the diff size and assume no prompt caching, so they err high.

## Pricing

Prices come from the model registry (`@merge-safely/registry`): input, output, cache-read and cache-write rates per model.

- **Unknown models are priced pessimistically**, at the maximum of every known rate in the registry (cache reads and writes at no less than the highest input rate), never left unpriced. Budgets always enforce. The only way to be wrong is to over-estimate. A warning is logged, and costs priced this way are marked estimated. `connect` marks them "(pessimistic rate)".
- **Local models are zero cost only on a local host.** Models of an `ollama` or `lmstudio` connection are free only when its base URL is `localhost`, a loopback address, or a private-network address (RFC 1918, link-local, IPv6 unique-local). A remote host, a hostname that merely resolves to a private address, and `-cloud` / `:cloud` tags are priced. `options.zeroCost` on the connection overrides this either way. Generic gateways (`openai-compatible` and the like) are always priced, and a paid gateway serving an open model never inherits its zero cost.
- Cost is recorded as streamed deltas from each runner's usage events as they arrive (the Claude Code CLI runner reports once, at exit, or the per-message usage it saw if the process was killed). A seat killed at its deadline has still been paid for, and the ledger shows it. The OpenAI and Gemini runners do not stream requests, so a request in flight when the deadline aborts it is not counted.
- Ledgers hold money as integer micro-dollars rounded up, so sums are exact and never under-count.

## Subscription connections

Under a `subscription` connection, plan-included work costs zero, so the dollar ceilings never trip and no dollar cap is passed to the CLI. The dollars are notional.

The real limit is the plan's usage window, which the gate cannot see. Once it is exhausted, seats fail, or, if your plan allows overage, continue at pay-as-you-go rates: real money that no Merge Safely ceiling will stop, because the gate records subscription work as zero cost. Watch your plan's usage yourself.

Read the terms caveat in [connections.md](connections.md#claude-subscription) before you use one.

## Alerts

The App alerts on the installation ceilings (window, all-time, monthly). `budget.alertThresholds` (default `[0.5, 0.8, 1.0]`) are fractions of a ceiling. Each alert fires once when spend crosses the threshold upward and re-arms only after spend drops back below it, so a ceiling held at 101% does not page every minute. Alerts go to the log and, with `SLACK_WEBHOOK_URL`, to Slack. The alert state persists across restarts. Unset and disabled ceilings never alert. The Action and the CLI do not send budget alerts.

## Resetting

The ledgers (`store-memory`, `store-fs`, `store-sqlite`) support `reset(installationId)`, which stores the current all-time total as a baseline and reports spend above it; history is kept, so per-change and window sums are unaffected. No CLI command or App page calls it yet; use the store package directly.

In the App, ceilings set through the setup page persist and are restored at boot, and override the repository policy's values for that installation. An empty field means "never configured" (the policy or the default applies); `0` means "disabled".
