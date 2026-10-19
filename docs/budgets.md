# Budgets and cost

You pay the model bill, so the gate has to be the thing that stops a bad night from becoming an invoice. Every dollar figure here is enforced against Merge Safely's own cost ledger, never against your provider's account usage.

## The ceilings

| Ceiling | Scope | Policy key | Default | On breach |
|---|---|---|---|---|
| Per seat | One reviewer run | `budget.perSeatUsd`, `budget.seatMaxTurns`, `budget.seatDeadlineMs` | $5, 50 turns, 10 min | The seat ends `budget-exceeded` (or `timeout` at the deadline), is excluded from quorum, and never counts as a pass. |
| Per change | One PR across all rounds | `budget.perChangeUsd` | $25 | Downgrade ladder, then block, naming the ceiling. |
| Rolling window | The installation over the last `windowDays` (at most 7) | `budget.windowUsd`, `budget.windowDays` | unset, 7 days | New reviews refused at admission. In-flight seats finish. |
| All-time | The installation, against the gate's own ledger | `budget.spendLimitUsd` | unset | Same as the rolling window. |

There is also a monthly installation ceiling:

| Ceiling | Scope | Policy key | Default | On breach |
|---|---|---|---|---|
| Monthly | The installation, calendar month | `budget.perInstallationMonthlyUsd` | unset | Enforced by the App. The Action evaluates it as advisory: it is reported, never blocks. |

### Semantics

- `null` (or absent) means never configured. `0` means explicitly disabled. Neither ever breaches.
- A ceiling breaches when projected spend is strictly greater than the limit. Projected spend is what has already been spent in that scope plus the estimate for the panel about to run.
- **Fail closed.** If a ceiling is configured but its spend cannot be read (no ledger, or a ledger error), it counts as breached, and the message says a ledger is required.
- When several ceilings breach, the binding one is reported in this order: all-time, window, monthly, per change, per seat.
- Installation-wide ceilings (window, all-time, monthly) refuse new reviews outright. A cheaper panel does not help the next PR.

### Where ceilings are checked

At admission, when a review is about to be seated, and again on a periodic tick. Never only when someone opens a page.

- The Action checks at job start.
- The App checks at webhook intake and on a timer.

## The downgrade ladder

With `budget.onOverBudget: downgrade-then-block` (the default), a panel that would breach a ceiling steps down in order, re-checking every ceiling after each step and stopping as soon as nothing blocks:

1. **Hunters' model.** Every hunter moves one model tier down (frontier → mid → small) on the same connection.
2. **Judges' model.** Every judge moves one tier down, but never below the hunters' tier.
3. **Seat count.** Hunter seats are dropped down to the quorum minimum, lowest priority first. Priority, highest first: `correctness`, `security`, `intent`, `rollout`, `repro`, `perf`, `blast-radius`, `design-fidelity`. Unlisted (third-party) lenses are dropped before any of these.
4. **Block.** Still over budget. The report names the binding ceiling and the policy key to raise.

Every step is recorded in the verdict's `downgrades`, and downgraded seats carry `downgradedFrom`, so a cheaper review is never mistaken for a full one.

With `budget.onOverBudget: block`, the panel blocks straight away.

A budget block reads like this:

```
Budget ceiling "per-change" would be exceeded: projected spend $27.40 ($19.10 already spent + $8.30 for this panel)
against a limit of $25.00. Raise budget.perChangeUsd in .merge-safely.yml, then re-run the check.
```

## A budget stop is a pause, not a crash

When a seat hits its turn or dollar cap, it ends `budget-exceeded`, never `error`. The digest spells out the recovery: raise the ceiling, re-run the check. Runners classify the exit from what they observed (the cap was reached, no stderr error), so a model process that exits non-zero because of its own budget flag is not reported as a crash.

## The cost line

Every check run summary and PR review ends with a cost line (unless `reporting.showCostInSummary: false`): dollars, tokens, seats, which connection served each seat, and whether a downgrade applied.

```
cost $1.84 · 3 seats · 2m 10s
```

The full breakdown is in the verdict's `cost`: total `usd`, `tokens`, and `bySeat` with the connection, model and dollars for each seat.

## Estimate before you run

```bash
merge-safely estimate --repo my-org/my-repo --pr 1234
merge-safely estimate --local
```

Prints the tier, the seats, the model for each seat and the estimated cost. Nothing runs and nothing is billed. Every surface shows the same three facts before the first run: which models each tier uses, the estimated cost per PR, and the budget ceiling.

## Pricing

Prices come from the model registry (`@merge-safely/registry`): input, output, cache-read and cache-write rates per model.

- **Unknown models are priced pessimistically**, at the maximum of every known rate in the registry, never left unpriced. Budgets always enforce. The only way to be wrong is to over-estimate. A warning is logged, and ledger rows priced this way are marked `estimated`.
- **Local models are zero cost.** Unknown models served by `ollama` or `lmstudio` are priced at zero, except tags ending in `-cloud`. Generic gateways (`openai-compatible` and the like) are always priced.
- Cost is recorded as streamed deltas from each runner's usage events as they arrive. A seat killed at its deadline has still been paid for, and the ledger shows it.

## Subscription connections

Under a `subscription` connection, plan-included work costs zero, so the dollar ceilings never trip and no dollar cap is passed to the CLI. The dollars are notional.

The real limit is the plan's usage window. Once it is exhausted, premium models may continue at pay-as-you-go rates, which is real money. When the subscription kind is enabled, the gate is designed to poll the plan's usage, back off on rate limits honouring `Retry-After`, alert at window thresholds, and refuse to seat premium models once the window is exhausted unless policy explicitly allows overage.

Read the terms caveat in [connections.md](connections.md#claude-subscription) before you use one.

## Alerts

`budget.alertThresholds` (default `[0.5, 0.8, 1.0]`) are fractions of a ceiling. Each alert fires once when spend crosses the threshold upward and re-arms only after spend drops back below it, so a ceiling held at 101% does not page every minute. Unset and disabled ceilings never alert.

## Resetting

Ledgers keep every row. Resetting the all-time counter stores the current total as a baseline and reports spend above it; per-change and window sums are unaffected.

In the App, ceilings set through the setup page persist and are restored at boot. A stored `null` means "use the default"; `0` means "disabled".
