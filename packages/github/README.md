# @merge-safely/github

GitHub adapters for Merge Safely: a `SourceProvider`, two `Reporter`s (check run and PR review), a
`VerdictStore` that lives inside the check run, `TrustProvider`s, webhook verification and App auth.

Every adapter takes an injected `octokit` typed as the structural `OctokitLike` (only the methods
this package calls), so a real `@octokit/rest` client and test fakes are interchangeable.

## Permissions

Least privilege (design section 8). Exported as `APP_PERMISSIONS`:

| Permission       | Level | Why |
| ---------------- | ----- | --- |
| `checks`         | write | the `merge-safely/verdict` check run: the merge signal and the verdict store |
| `pull_requests`  | write | the review digest and inline comments; PR files and commits |
| `contents`       | read  | diffs, commit statuses, check runs, checkout of the head SHA |
| `members`        | read  | **only** with `trust.provider: github-teams` (`APP_PERMISSIONS_WITHOUT_TEAMS` otherwise) |
| `metadata`       | read  | mandatory for every App |

Webhook events for the App: `pull_request`, `check_run`, `check_suite`.

The gate never posts an `APPROVE` review. A machine verdict is a check-run signal for merge rules,
never a human approval that could satisfy a required-reviewers rule.

## Identity: whose check runs and comments count

Check runs, the round-history comment and the review/comment markers only count when **our own
identity** wrote them, so another App, a bot or a human cannot forge a verdict or suppress the gate
by reusing the check name or a marker.

- **App mode:** the App is discovered with `GET /app` (id and slug); check runs must carry that app
  id, and markers must be posted by `<slug>[bot]`.
- **Action mode (`GITHUB_TOKEN`):** `GET /app` is refused, so the identity is `github-actions`
  (`github-actions[bot]`). This is weaker: every workflow in the repo, including one edited in a
  same-repo PR branch, runs as `github-actions` and can write a `merge-safely/verdict` run. Use the App
  for protected branches.
- Override with `appSlug`, `appId` and `botLogin` on any adapter.
- In rulesets, require the check **and pin its expected source app** (the App, or GitHub Actions).

## GitHub Action usage

```yaml
on: { pull_request: { types: [opened, synchronize, reopened, ready_for_review] } }
permissions: { checks: write, pull-requests: write, contents: read }
concurrency: { group: merge-safely-${{ github.event.pull_request.number }}, cancel-in-progress: false }
```

```ts
import {
  checkRunReporter, checkRunStore, githubSource, octokitFromToken, parseRepo, prReviewReporter, trustFromPolicy,
} from "@merge-safely/github";

const octokit = octokitFromToken(process.env.GITHUB_TOKEN ?? "");
const source = githubSource({ octokit });
const store = checkRunStore({ octokit, policy });               // the only writer of verdict state
const reporters = [checkRunReporter({ octokit, policy }), prReviewReporter({ octokit, policy })];
const trust = trustFromPolicy(policy); // github-teams needs a token that can read org members
const change = await source.getChange({ repo: parseRepo(process.env.GITHUB_REPOSITORY ?? ""), number });
const diff = await source.getDiff(change, { headSha: change.headSha }); // always pin the reviewed head
```

All three adapters read the check name from `policy.reporting.checkName` (override with `checkName`).

## CLI with a personal access token

The Checks API is **App-only**: a PAT (classic or fine-grained) cannot create check runs, so
`checkRunReporter` and `checkRunStore` do not work with one. With a PAT, use:

- `commitStatusReporter({ octokit, policy })` for the merge signal (a commit status with the
  digest headline; needs `repo:status` / "Commit statuses: write"), plus `prReviewReporter` for the digest;
- a local store (`@merge-safely/store-fs` or `@merge-safely/store-sqlite`) instead of `checkRunStore`.

Commit statuses are weaker than App check runs: anyone with status write access can set the context.

## GitHub App usage

```ts
import { changeRefFromEvent, createAppOctokit, githubSource, verifyWebhookSignature } from "@merge-safely/github";

// In your HTTP handler, with the raw body bytes:
if (!verifyWebhookSignature(secret, rawBody, req.headers["x-hub-signature-256"])) return res.status(401).end();
const payload = JSON.parse(rawBody.toString("utf8"));
const hit = changeRefFromEvent(req.headers["x-github-event"], payload, { triggerLabels: ["ai-authored"] });
if (!hit || hit.draft) return res.status(204).end();
// hit.reason === "base-changed": the PR was retargeted; run a full (not delta) review.
// hit.targetEvent: delivered as pull_request_target; decide whether to act.

const octokit = createAppOctokit({ appId, privateKey, installationId: payload.installation.id });
await queue.enqueue({ ref: hit.ref, headSha: hit.headSha }); // review with githubSource({ octokit }) etc.
```

`createAppJwtOctokit(appId, privateKey)` authenticates as the App itself (for listing installations).
`labeled` events only trigger for `triggerLabels` (default none); `unlabeled` and title/body edits are ignored.

## The check run is the store

`checkRunStore` keeps the verdict in the check run's `output.text` as a fenced JSON block after a
`<!-- merge-safely:verdict -->` marker. The store is the **only** writer of `output.text`:
`checkRunReporter` writes status, conclusion, title, summary and annotations, and re-sends the
existing text unchanged; `put` re-sends the reporter's title and summary unchanged. One check run
exists per (check name, head SHA, our app), so the verdict is SHA-bound: a new push gets a new check
run, and an old green verdict cannot satisfy the required check for the new SHA.

- `get(key)` reads our newest `merge-safely/verdict` run for the SHA and parses the block.
- `put(v, { version })` re-reads, compares versions (run id + completion time + text hash), and
  writes `output.text`. With no run yet it creates a completed run with the verdict's conclusion.
- GitHub caps `output.text` at 65,535 characters. `serializeVerdict` compacts: seat outputs shrink to
  verdict + summary, `audit.filesRead`/`commandsRun` keep 20 entries, and further levels drop audit
  lists, clip finding detail, then drop seats, then keep only the most severe findings that fit.
- CAS is read-compare-write (GitHub has no conditional update). Use one review per SHA at a time.

### Round history survives force-pushes

`pulls.listCommits` only returns commits reachable from the current head, so after an amend or
rebase plus force-push the earlier SHAs' check runs can no longer be found from the PR. Each `put`
therefore also upserts a compact entry (`headSha`, `round`, `decision`, `createdAt`, `policyHash`,
tier level, and findings' id/severity/class/title/file/line) into a single bot-authored PR comment
marked `<!-- merge-safely:index -->`. `listForChange` reads that index and returns the full verdict
from the check run where it still exists (and holds that round), else the compact entry hydrated
into a `Verdict` (no seats, zero cost). It falls back to walking the PR's commits only when no index
exists. The comment is capped at 65,535 characters by dropping finding details oldest-first; SHA,
round and decision are never dropped. A failed index update is logged and does not fail the `put`.

## Other behaviour worth knowing

- `ciStatus` ignores check runs and statuses whose name starts with `merge-safely/`, so the gate never
  reads itself. Precedence: failure > pending > success; nothing at all is `unknown`.
- `getDiff(ref, { headSha, sinceSha })` diffs `base...headSha` (or `sinceSha...headSha`). The
  orchestrator always passes the pinned head, so a push landing mid-review cannot swap the diff.
- Above 300 files / 20,000 changed lines (or when GitHub refuses the diff) it falls back to
  concatenated per-file patches, ending with `# merge-safely: diff truncated (...)` when files had no
  patch, were not returned, or the compare endpoint's 300-file cap was reached.
- Inline review comments are only placed on RIGHT-side lines inside the PR's diff hunks; if GitHub
  still rejects one, the review is re-posted without inline comments.
- On a non-contested pass, our own earlier `CHANGES_REQUESTED` reviews are dismissed ("superseded by
  verdict on <sha>") so they stop blocking required-review protection. A block never dismisses.
- A same-SHA re-run updates the summary and conclusion but does not re-post annotations (GitHub
  appends them and cannot remove them).
- Team lookup errors classify the author as `standard` (no bypass, still reviewed), never `trusted`.
- Error text goes to the check run (secret-shaped strings redacted), never to a PR comment.
