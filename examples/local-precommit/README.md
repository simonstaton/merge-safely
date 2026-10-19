# Local pre-push review

`pre-push` runs `merge-safely run --local` against your base branch before every `git push`. It is the same pipeline, lenses and connections as the PR gate, with nothing written to GitHub or a verdict store.

```bash
cp examples/local-precommit/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

| Variable | Default | Meaning |
|---|---|---|
| `MERGE_SAFELY_BASE` | `origin/main` | Base ref to review against. |
| `MERGE_SAFELY_SKIP` | unset | Set to `1` to skip the review for one push. |

The hook treats a non-zero exit from `merge-safely run --local` as a block and stops the push.

Each push costs a review. Run `merge-safely estimate --local` to see the cost first. Tiny docs-only changes are triaged with no model call.

The hook reviews your working tree, so uncommitted changes are included. Commit or stash first if you want to review exactly what you push.

To share the hook across a team, put it in a tracked directory and set `git config core.hooksPath <dir>`, or call it from your hook manager.
