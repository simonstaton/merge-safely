# Local pre-push review

`pre-push` runs `merge-safely run --local` against your base branch before every `git push`. It is the same pipeline, lenses, policy and connections as the PR gate, with nothing written to GitHub or a verdict store.

It needs `merge-safely` on your `PATH` (from a checkout: `npm ci && npm run build && npm link -w packages/cli`; see [docs/quickstart-cli.md](../../docs/quickstart-cli.md)) and at least one connection made with `merge-safely connect`. Without `merge-safely` on the `PATH`, the hook tries `npx --no-install merge-safely`, which only works where the CLI is installed in the project.

```bash
cp examples/local-precommit/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

| Variable | Default | Meaning |
|---|---|---|
| `MERGE_SAFELY_BASE` | `origin/main` | Base ref to review against. If it does not exist, the hook prints a notice and lets the push through. |
| `MERGE_SAFELY_SKIP` | unset | Set to `1` to skip the review for one push (or use `git push --no-verify`). |

The hook stops the push on any non-zero exit from `merge-safely run --local`: a block (1), a pending or contested review, an error such as `NO_CONNECTIONS` or `CONNECTION_UNREACHABLE` (2), or a budget refusal (3).

Each push costs a review. Run `merge-safely estimate --local` to see the cost first. Small tier 0 changes (docs, assets, lockfiles, or at most 30 lines in at most 3 files) are triaged with no review, but the hook still checks that your connections are reachable.

The hook reviews your working tree, so uncommitted and untracked changes are included. Commit or stash first if you want to review exactly what you push.

To share the hook across a team, put it in a tracked directory and set `git config core.hooksPath <dir>`, or call it from your hook manager.
