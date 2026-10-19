# Ruleset: require the verdict

[`required-check.json`](required-check.json) is a repository ruleset for the default branch that requires the `merge-safely/verdict` check and lets one team bypass it.

Import it under **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or with the API:

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input examples/rulesets/required-check.json
```

Before you import it:

- Replace `actor_id` `1234567` with your team's id (`gh api orgs/<org>/teams/<team-slug> --jq .id`), or remove `bypass_actors`. Keep bypass in line with `trust.trustedBypassMaxTier` in your policy.
- **Pin the check's source.** Add `"integration_id"` next to `"context"` so only the gate's own identity can satisfy the check: your GitHub App's id when you run the self-hosted App, or `15368` (GitHub Actions) when you use the Action. Without it, any App or workflow that can write a check run named `merge-safely/verdict` can satisfy the rule.
- If you changed `reporting.checkName`, use that name as the `context`.

`strict_required_status_checks_policy` is `false` because the verdict is already bound to the head SHA: a push after a green verdict puts the check back to pending, so "require branches to be up to date" is not needed for the verdict itself. Turn it on if your other required checks need it.

The `pull_request` rule requires no human approvals and dismisses stale approvals on push; raise `required_approving_review_count` if you also want human review. Merge Safely never posts an `APPROVE` review, so it can never satisfy a required-reviewers rule.
