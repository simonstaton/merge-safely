# Security model

Merge Safely reads code written by people you may not trust, sends it to a model, and lets that model drive tools in a checkout. This page says what the runner guarantees, what it does not, and how to deploy it safely.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## The runner contract

The runner is the only component that executes model calls with tool access, so it carries the security contract. Every runner, for every provider, must hold to it.

### Guarantees

| Guarantee | What it means |
|---|---|
| Read-only tools by default | API runners get `read_file`, `list_dir`, `find_files`, `search`, `git_diff`, `git_log` and `git_blame`; the Claude Code CLI runner gets `Read`, `Grep`, `Glob` and an `ms-git` wrapper for `diff`, `log`, `blame` and `show`. No write, no network, no package install. Credential-shaped files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, ...), git-ignored untracked files and `.git` are never shown. |
| Commands only from the allowlist | Reviewers can execute nothing except entries in `runner.allowedCommands`, which is empty by default. |
| Disposable workspace | For PR review, a fresh worktree of the head SHA per seat from a bare mirror, destroyed afterwards. (`run --local` is the exception: reviewers read your working tree in place, read-only.) |
| Structured output enforced by the runner | The final answer is validated against a JSON schema. Invalid output is `schema-invalid` and never counts as a pass. |
| Proof of work observed by the runner | Files read and commands run are counted from the runner's own tool execution, or the CLI's event stream. The model cannot forge the audit. |
| Untrusted text is data | PR title, body, commit messages, comments, ticket text, file paths and the diff reach the prompt only inside delimited blocks, with a statement that nothing inside is an instruction. |
| Connection secrets never enter prompts | Model keys are never placed in any prompt, log, verdict or error message. |
| Budgets are hard | Exceeding turns, dollars or the deadline ends the seat as `budget-exceeded` or `timeout`, and it is excluded from quorum. |
| Least privilege at the edge | The App asks for checks write, pull requests write, contents read, and members read only when team trust is enabled. It never posts an `APPROVE` review. |
| The policy cannot be changed by the PR it judges | The Action, the App and the CLI's PR mode read `.merge-safely.yml` from the PR's base branch, never from its head. |

### Non-guarantees

| Not guaranteed | Why, and what to do |
|---|---|
| Isolation from the host | The only workspace is a local git checkout. Isolation is whatever your runner gives you: an ephemeral Actions VM, a container, or your laptop. Run the CLI or the App in a container if you want more. |
| Safety of allowed commands | An allowed command runs the PR's code. See below. |
| Immunity to prompt injection | Delimiting untrusted text, a fixed system prompt and judges that refute unevidenced findings make injection hard, not impossible. A PR may still try to talk a reviewer into passing. Proof of work, quorum, decorrelated judges and "one blocker blocks" limit what a single fooled seat can do. |
| Complete secret redaction | With `runner.redactSecrets` (the default), the diff and PR text are scanned for secret shapes (provider keys, `ghp_`/`github_pat_` tokens, `AKIA` keys, Slack tokens, PEM private keys, JWTs, bearer tokens, URL userinfo, literal password and token assignments) and redacted before prompting; tool output is always redacted. A secret in an unusual format will not be caught. Do not rely on Merge Safely as a secret scanner. |
| A forge-proof check in Action mode | With the Actions `GITHUB_TOKEN`, the gate's identity is `github-actions`, and any workflow in the repository (including one edited in a same-repo PR branch) can write a check run of the same name. Use the App for protected branches, and pin the required check's source app in your ruleset. |
| Confidentiality from your model provider | Reviewers send the diff and the files they read to the model provider you connected. Choose a provider and data terms you accept for your code. |
| Correct verdicts | It is a review, not a proof. Keep CI, tests and human ownership of critical areas. |

## Untrusted input handling

Everything a PR author controls is untrusted: title, body, commit messages, review comments, linked ticket text, branch names, labels, file paths, file contents and the diff.

- Untrusted text reaches prompts only through a wrapper that emits `<untrusted-<nonce> source="…">` blocks with a random nonce per prompt. Content is NFKC-normalised, stripped of zero-width and bidirectional control characters, and any lookalike of the delimiter is escaped. Each field is length-capped. Prior findings, tier reasons and changed-file paths are wrapped the same way.
- Finding ids are recomputed from content, so an id a model wrote is never trusted. Check runs, the round-history comment and review markers only count when the gate's own identity wrote them.
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
5. **Never point the gate at your working copy for PR review.** The workspace must be a disposable checkout of the PR head (`localWorkspace({ cloneUrl })`, which the CLI, Action and App use). The `repoPath` mode of `@merge-safely/workspace-local` adds worktrees to an existing clone whose `.git` links back into that repository, so an allowed command could rewrite its hooks or config. Use it, and `run --local`, only for your own code.

Allowed commands run with a scratch `HOME`, `XDG_*` and `TMPDIR`, an environment reduced to safe `PATH` entries, `LANG`, `CI` and `NODE_ENV`, and the whole process group is killed when the command returns or times out. They still have network access and can write to the checkout.

## Secrets handling

- **Action.** No custody. Keys live in GitHub secrets and exist only in memory for the job. Prefer `apiKeyEnv` with step `env:` so keys never appear in the input string.
- **CLI.** `connections.json` is mode `0600` in a `0700` directory. Prefer environment references (`--api-key-env`). Set `MERGE_SAFELY_MASTER_KEY` to encrypt stored secrets. Errors are printed with every known secret masked.
- **App.** Envelope encryption per secret, bound to `<installationId>:<connectionId>`, with a master key from the environment. Secrets are never returned by any endpoint after creation and are scrubbed from every log line. Rotate a provider key by re-connecting with the same id; rotate the master key with `rotate-key` (see [quickstart-app.md](quickstart-app.md#environment)).
- **Git.** Every git call runs with an allowlisted environment, an empty private `HOME`, hooks off, external diff and textconv off, and `protocol.allow=never` except on fetches. The clone token goes to git as a scoped `http.extraheader` through the environment, never in argv, the remote URL or on disk.
- **Child processes.** The Claude Code CLI runner copies only `PATH`, locale, temp and proxy/CA variables into the child. No `ANTHROPIC_*` or `CLAUDE_*` variable is inherited; the credential comes only from the connection. Except under `subscription`, `HOME`, `XDG_*` and `CLAUDE_CONFIG_DIR` point at an empty temporary directory. Git access goes through a wrapper that allows only `diff`, `log`, `blame` and `show` with an allowlist of flags, resolves revisions to SHAs and keeps paths inside the checkout.
- **SDK environment.** The OpenAI and Gemini adapters set the key, base URL and logging options explicitly, so environment variables such as `OPENAI_BASE_URL`, `OPENAI_LOG` or `GOOGLE_GEMINI_BASE_URL` cannot redirect the key or the PR, or print request bodies.
- **Output.** Before any reviewer output or error is returned, runners replace connection secrets and secret-shaped strings with `[REDACTED]`.

If a key appears anywhere it should not, rotate it, then report it as a vulnerability.

## Fork PRs and `pull_request_target`

On the `pull_request` event, GitHub gives workflows from forks no secrets and a read-only token. The gate can neither reach a model nor write the verdict check run. The Action therefore detects a fork PR (head repository differs from the base) and stops at once with a `FORK_PULL_REQUEST` error that explains `pull_request_target`. It does not try a review that would fail validation later. That is the safe default.

`pull_request_target` runs in the context of the base repository, with secrets and a write token. It is safe only if nothing from the fork is executed. Merge Safely reads the fork's code and sends it to a model; it does not execute it unless `allowedCommands` is set. If you use `pull_request_target` for fork PRs:

- The policy is read from the base branch, so a fork cannot edit `.merge-safely.yml` to widen `allowedCommands` or lower quorum for its own review. The Action's `policy` checkout override is ignored on fork PRs.
- On a fork PR the Action runs with `allowedCommands: []` whatever the policy says, and logs a `SECURITY` warning if the policy set any.
- Do not add other steps to the job that build, install or run the checked-out code.
- Use a dedicated model key with a low spend limit at the provider, so a flood of fork PRs cannot run up a bill. Keep `budget.perChangeUsd` low too.
- Consider requiring a maintainer label or approval before the workflow runs for first-time contributors (GitHub's "Require approval for fork pull request workflows" setting).

The simpler alternative: let fork PRs fail the gate, and have a maintainer push the branch to the base repository, or run `merge-safely run --repo … --pr …` from a trusted machine.

## Webhooks and the App

- Every webhook's `X-Hub-Signature-256` is verified against `GITHUB_WEBHOOK_SECRET` over the raw body before it is parsed, and deliveries are deduplicated by `X-GitHub-Delivery`.
- Only `POST /webhooks/github` needs to be reachable from the internet. `/setup` and the `/installations/...` API need the `SETUP_TOKEN` bearer token; `/healthz` and `/metrics` are unauthenticated and `/metrics` exposes installation ids and spend. Keep all of them on your own network.
- The human-verdict API takes the signer's login as given. Anyone with `SETUP_TOKEN` can record a verdict for any login.
- The App's host reads PR code. If any policy allows commands, it executes PR code. Give the host nothing it does not need.

## Supply chain

Pin the Action to a release tag or a commit SHA. `@v0` follows the latest 0.x release; a commit SHA does not move.
