# Merge bots and required checks

Merge Safely never merges. It publishes one check run per head SHA, named by `reporting.checkName` (default `merge-safely/verdict`):

| Check state | Meaning |
|---|---|
| pending (in progress) | A review is running for this SHA, or a new push has made the last verdict stale. |
| success | Verdict `pass` for this exact SHA. Includes triaged auto-passes. |
| failure | Verdict `block` for this SHA, or the review could not complete (bad connection, budget block, error). The summary says which. |

Whatever merges your PRs gates on that check. Because the check is bound to the head SHA, a push after a green verdict leaves the new SHA without a green check. That closes the stale-approval hole without an extra rule.

Merge Safely's review comes from a machine. A verdict's `kind` is `machine` unless a human recorded it. If your process needs a human approval as well, keep requiring one.

## GitHub rulesets

Require the check on your default branch. [examples/rulesets/required-check.json](../examples/rulesets/required-check.json):

```json
{
  "name": "merge-safely verdict required",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 1234567,
      "actor_type": "Team",
      "bypass_mode": "pull_request"
    }
  ],
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {
            "context": "merge-safely/verdict"
          }
        ]
      }
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
```

Import it under **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or with the API:

```bash
gh api -X POST repos/my-org/my-repo/rulesets --input examples/rulesets/required-check.json
```

Notes:

- Replace `actor_id` with your trusted team's id (`gh api orgs/my-org/teams/my-team --jq .id`), or remove `bypass_actors`. Bypass actors mirror `trust.trustedBypassMaxTier`, but a ruleset cannot see tiers: a bypass actor can bypass at every tier, including tier 3. If that is wider than your policy allows, do not grant the bypass, or keep it as a documented break-glass.
- To pin the check to its source, add `"integration_id"` to the required check entry: the GitHub Actions app id (`15368`) for the Action, or your own App's id for the self-hosted App. This stops a different app from satisfying the check by posting one with the same name. It does not distinguish between workflows in the same repository, so protect `.github/workflows/**` (a default critical path) as well.
- If you changed `reporting.checkName`, use that name.

Classic branch protection works the same way: require the status check `merge-safely/verdict`.

## Mergify

Add the check to your queue conditions. [examples/mergify/.mergify.yml](../examples/mergify/.mergify.yml):

```yaml
# Mergify: queue a PR only when the Merge Safely verdict passes on its current head SHA.
queue_rules:
  - name: default
    queue_conditions:
      - base = main
      - -draft
      - check-success = merge-safely/verdict
    # merge_conditions are evaluated on the queue's own test branch or draft PR, which Merge Safely does not
    # review. Put your CI checks here, not the verdict.
    merge_conditions:
      - check-success = ci

pull_request_rules:
  - name: queue when the verdict passes
    conditions:
      - base = main
      - -draft
      - check-success = merge-safely/verdict
      # Keeps a person in charge of when to merge. Remove to queue every passing PR.
      - label = ready-to-merge
    actions:
      queue:
        name: default
```

This replaces rules like "no human comments means merge". Replace `ci` with your CI check names. The `label` condition keeps a person in charge of when to merge; drop it if you want every passing PR queued.

## GitHub merge queue

Enable the merge queue in a ruleset and require `merge-safely/verdict` as above. A PR cannot enter the queue until the check is green on its head SHA.

GitHub also evaluates required checks on the temporary merge-group commit. Merge Safely reviews pull requests, not merge groups, so a required check that never reports on the merge group will hold the queue. Before you rely on the merge queue, confirm that your version of the Action or App reports on `merge_group` events. If it does not, make the merge queue's required checks your CI checks only, and require `merge-safely/verdict` on the PR through the ruleset.

## Reading the verdict JSON

For anything else, read the verdict. The full object is the `Verdict` type in [`packages/core/src/types.ts`](../packages/core/src/types.ts). Ways to get it:

```bash
merge-safely run --repo my-org/my-repo --pr 1234 --report json      # run a review and print the verdict
merge-safely explain --repo my-org/my-repo --pr 1234                # the digest of the latest verdict
```

With the filesystem store, each verdict is a file at `<MERGE_SAFELY_HOME>/verdicts/<host>/<owner>/<name>/<number>/<sha>.json`. Path segments are lower-cased and percent-encoded.

The fields a gate should check:

| Field | Check |
|---|---|
| `headSha` | Equals the PR's current head SHA. A verdict for any other SHA is stale. |
| `decision` | `pass`. `pending` and `block` are not a pass. |
| `kind` | `machine` or `human`. Decide whether your process accepts a machine pass alone. |
| `contested` | If `true`, a pass was rejected because an unresolved block exists for this SHA. |
| `tier.level` | 0 to 3. Use it to route: for example, require a human at tier 3. |
| `triaged` | `true` when the deterministic triage stage auto-passed it with zero seats. |
| `downgrades` | Present when the budget ladder ran a cheaper panel than the policy asked for. |
| `policyHash` | The policy that produced it. Compare against the hash you expect if policy drift matters. |
| `expiresAt` | If set and in the past, treat as stale. |

A minimal check:

```bash
jq -e --arg sha "$HEAD_SHA" '.headSha == $sha and .decision == "pass" and (.contested | not)' verdict.json
```
