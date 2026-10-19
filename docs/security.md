# Security model

Merge Safely reads code written by people you may not trust, sends it to a model, and lets that model drive tools in a checkout. This page says what the runner guarantees, what it does not, and how to deploy it safely.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## The runner contract

The runner is the only component that executes model calls with tool access, so it carries the security contract. Every runner, for every provider, must hold to it.

### Guarantees

| Guarantee | What it means |
|---|---|
| Read-only tools by default | Reviewers can read files, list, grep, and run `git diff`, `log`, `blame` and `show`. No write, no network beyond the model API, no package install. |
| Commands only from the allowlist | Reviewers can execute nothing except entries in `runner.allowedCommands`, which is empty by default. |
| Disposable workspace | A fresh checkout of the head SHA per seat, destroyed afterwards. |
| Structured output enforced by the runner | The final answer is validated against a JSON schema. Invalid output is `schema-invalid` and never counts as a pass. |
| Proof of work observed by the runner | Files read and commands run are counted from the runner's own tool execution, or the CLI's event stream. The model cannot forge the audit. |
| Untrusted text is data | PR title, body, commit messages, comments, ticket text, file paths and the diff reach the prompt only inside delimited blocks, with a statement that nothing inside is an instruction. |
| Connection secrets never enter prompts | Model keys are never placed in any prompt, log, verdict or error message. |
| Budgets are hard | Exceeding turns, dollars or the deadline ends the seat as `budget-exceeded` or `timeout`, and it is excluded from quorum. |
| Least privilege at the edge | The App asks for checks write, pull requests write, contents read, and members read only when team trust is enabled. |

### Non-guarantees

| Not guaranteed | Why, and what to do |
|---|---|
| Isolation from the host | The 0.1 workspace is a local git checkout. Isolation is whatever your runner gives you: an ephemeral Actions VM, a container, or your laptop. Container and remote-sandbox workspaces are planned. |
| Safety of allowed commands | An allowed command runs the PR's code. See below. |
| Immunity to prompt injection | Delimiting untrusted text, a fixed system prompt and judges that refute unevidenced findings make injection hard, not impossible. A PR may still try to talk a reviewer into passing. Proof of work, quorum, decorrelated judges and "one blocker blocks" limit what a single fooled seat can do. |
| Complete secret redaction | Diffs are scanned for secret shapes (`sk-`, `ghp_`, `AKIA`, PEM keys, bearer tokens, URL userinfo and similar) and redacted before prompting. A secret in an unusual format will not be caught. Do not rely on Merge Safely as a secret scanner. |
| Confidentiality from your model provider | Reviewers send the diff and the files they read to the model provider you connected. Choose a provider and data terms you accept for your code. |
| Correct verdicts | It is a review, not a proof. Keep CI, tests and human ownership of critical areas. |

## Untrusted input handling

Everything a PR author controls is untrusted: title, body, commit messages, review comments, linked ticket text, branch names, labels, file paths, file contents and the diff.

- Untrusted text reaches prompts only through a wrapper that emits `<untrusted-<nonce> source="…">` blocks with a random nonce per prompt. Content is NFKC-normalised, stripped of zero-width and bidirectional control characters, and any lookalike of the delimiter is escaped. Each field is length-capped.
- Lens prompt builders never see the PR title, body, comments, ticket or diff. File paths reach them hard-sanitised.
- Findings may quote PR text. Actions requested by PR text are never taken.
- The Claude Code CLI runner replaces Claude Code's default system prompt, which would embed branch names and commit subjects, and runs with no `CLAUDE.md`, skills, hooks, plugins or MCP servers from the checkout.
- Agent configuration files (`.claude/`, `.cursor/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`) and `.merge-safely.yml` are default critical paths, so a PR that edits them is always reviewed at tier 3.
- Reporters must treat finding text and PR text as untrusted when rendering. The Slack adapter strips control characters and backticks and escapes `&`, `<` and `>`, which blocks forged lines, `<!channel>` and mention injection. Bare URLs in untrusted text can still be auto-linked by Slack.

## What `allowedCommands` exposes

`runner.allowedCommands` lets reviewers run commands such as `npm test`. This gives the `repro` lens real evidence. It also means **the PR's code executes on the machine running the gate**: test files, build config, install scripts, and anything they import.

Matching:

- Exact match by default. `"npm test"` allows `npm test` and nothing else.
- A trailing ` *` allows extra arguments after the prefix: `"npx vitest run *"`.
- The Claude Code CLI runner rejects entries with shell metacharacters, bare interpreters or shells (`node`, `python3`, `bash`, `env`, `find`, `xargs`, …) and raw `git`.

Exact matching stops a reviewer from running `curl` or `rm`. It does not stop the PR's own test from doing so.

Rules:

1. **Leave it empty unless you need it.** Read-only review is the default for a reason.
2. **Only enable it inside a sandbox.** An ephemeral VM or container with no credentials beyond the model key, and ideally egress limited to the model endpoint.
3. **Never enable it for fork PRs** or for any author you would not let run code on that machine.
4. **Never enable it under a `subscription` connection** unless the repository and authors are trusted. Under a subscription the CLI runs with your real `HOME`, so a test could read your Claude login.
5. **Never point the gate at your working copy for PR review.** The workspace must be a disposable checkout of the PR head. Reviewing a PR against a long-lived checkout (a "repo path" mode) lets an allowed command, or a bug, touch files you care about. Use `run --local` only for your own uncommitted work.

## Secrets handling

- **Action.** No custody. Keys live in GitHub secrets and exist only in memory for the job. Prefer `apiKeyEnv` with step `env:` so keys never appear in the input string.
- **CLI.** `connections.json` is mode `0600` in a `0700` directory. Prefer environment references. Set `MERGE_SAFELY_MASTER_KEY` to encrypt stored secrets.
- **App.** Envelope encryption per connection, with a master key from the environment. Secrets are never returned by any endpoint after creation. Rotation is a re-connect.
- **Child processes.** The Claude Code CLI runner copies only `PATH`, locale, temp and proxy/CA variables into the child. No `ANTHROPIC_*` or `CLAUDE_*` variable is inherited; the credential comes only from the connection. Except under `subscription`, `HOME`, `XDG_*` and `CLAUDE_CONFIG_DIR` point at an empty temporary directory. Git access goes through a wrapper that allows only `diff`, `log`, `blame` and `show` with an allowlist of flags, resolves revisions to SHAs and keeps paths inside the checkout.
- **SDK environment.** The OpenAI and Gemini adapters set the key, base URL and logging options explicitly, so environment variables such as `OPENAI_BASE_URL`, `OPENAI_LOG` or `GOOGLE_GEMINI_BASE_URL` cannot redirect the key or the PR, or print request bodies.
- **Output.** Before any reviewer output or error is returned, runners replace connection secrets and secret-shaped strings with `[REDACTED]`.

If a key appears anywhere it should not, rotate it, then report it as a vulnerability.

## Fork PRs and `pull_request_target`

On the `pull_request` event, GitHub gives workflows from forks no secrets and a read-only token. The gate cannot reach a model, so fork PRs fail validation. That is the safe default.

`pull_request_target` runs in the context of the base repository, with secrets and a write token. It is safe only if nothing from the fork is executed. Merge Safely reads the fork's code and sends it to a model; it does not execute it unless `allowedCommands` is set. If you use `pull_request_target` for fork PRs:

- Keep `runner.allowedCommands` empty. With commands allowed, a fork PR can run code next to your model keys and your write token.
- Make sure the policy that governs the run cannot be changed by the fork. A fork that edits `.merge-safely.yml` in its own branch must not be able to widen `allowedCommands` or lower quorum for its own review. Check which ref your setup reads the policy from.
- Do not add other steps to the job that build, install or run the checked-out code.
- Use a dedicated model key with a low spend limit at the provider, so a flood of fork PRs cannot run up a bill. Keep `budget.perChangeUsd` low too.
- Consider requiring a maintainer label or approval before the workflow runs for first-time contributors (GitHub's "Require approval for fork pull request workflows" setting).

The simpler alternative: let fork PRs fail the gate, and have a maintainer push the branch to the base repository, or run `merge-safely run --repo … --pr …` from a trusted machine.

## Webhooks and the App

- Every webhook's signature is verified against `GITHUB_WEBHOOK_SECRET` before it is processed.
- Only `POST /webhooks/github` needs to be reachable from the internet. Put `/setup` behind your own access control.
- The App's host reads PR code. If any policy allows commands, it executes PR code. Give the host nothing it does not need.

## Supply chain

Pin the Action to a release tag or a commit SHA. `@v0` follows the latest 0.x release; a commit SHA does not move.
