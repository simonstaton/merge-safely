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
const store = checkRunStore({ octokit, checkName: policy.reporting.checkName });
const reporters = [
  checkRunReporter({ octokit, checkName: policy.reporting.checkName }),
  prReviewReporter({ octokit, policy }),
];
const trust = trustFromPolicy(policy); // github-teams needs a token that can read org members
const change = await source.getChange({ repo: parseRepo(process.env.GITHUB_REPOSITORY ?? ""), number });
```

## GitHub App usage

```ts
import { changeRefFromEvent, createAppOctokit, githubSource, verifyWebhookSignature } from "@merge-safely/github";

// In your HTTP handler, with the raw body bytes:
if (!verifyWebhookSignature(secret, rawBody, req.headers["x-hub-signature-256"])) return res.status(401).end();
const payload = JSON.parse(rawBody.toString("utf8"));
const hit = changeRefFromEvent(req.headers["x-github-event"], payload);
if (!hit || hit.draft) return res.status(204).end();

const octokit = createAppOctokit({ appId, privateKey, installationId: payload.installation.id });
await queue.enqueue({ ref: hit.ref, headSha: hit.headSha }); // review with githubSource({ octokit }) etc.
```

`createAppJwtOctokit(appId, privateKey)` authenticates as the App itself (for listing installations).

## The check run is the store

`checkRunStore` keeps the verdict in the check run's `output.text` as a fenced JSON block after a
`<!-- merge-safely:verdict -->` marker; `checkRunReporter` writes the same block when it completes a
run. One check run exists per (check name, head SHA), so the verdict is SHA-bound: a new push gets a
new check run, and the old green verdict cannot satisfy the required check for the new SHA.

- `get(key)` reads the newest `merge-safely/verdict` run for the SHA and parses the block.
- `put(v, { version })` re-reads, compares versions (run id + completion time + text hash), and
  writes `output.text` only (title and summary written by the reporter are kept). With no run yet it
  creates a completed run with the verdict's conclusion.
- `listForChange` walks the PR's commits and returns their verdicts, oldest first.
- GitHub caps `output.text` at 65,535 characters. `serializeVerdict` compacts: seat outputs shrink to
  verdict + summary, `audit.filesRead`/`commandsRun` keep 20 entries, and further levels drop audit
  lists, clip finding detail, then drop seats, then keep only the most severe findings that fit.
- CAS is read-compare-write (GitHub has no conditional update). Use one review per SHA at a time.

## Other behaviour worth knowing

- `ciStatus` ignores check runs and statuses whose name starts with `merge-safely/`, so the gate never
  reads itself. Precedence: failure > pending > success; nothing at all is `unknown`.
- `getDiff` falls back to concatenated per-file patches above 300 files / 20,000 changed lines (or when
  GitHub refuses the diff), ending with `# merge-safely: diff truncated (N files omitted)` when files
  had no patch or were not returned.
- Inline review comments are only placed on RIGHT-side lines present in the PR's diff hunks; if
  GitHub still rejects one, the review is re-posted without inline comments.
- Error text goes to the check run (secret-shaped strings redacted), never to a PR comment.
