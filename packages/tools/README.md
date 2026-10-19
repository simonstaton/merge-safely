# @merge-safely/tools

The shared read-only tool set that every API runner gives reviewer models, plus a proof-of-work audit that the runner observes itself. The model never executes anything. The runner calls `execute()` inside a workspace checkout and records what happened.

```ts
import { createReadOnlyTools, toAnthropicTools, submitReviewDefinition } from "@merge-safely/tools";

const tools = createReadOnlyTools(handle, { allowedCommands: ["npm test"], maxOutputBytes: 64 * 1024 });
const defs = [...tools.definitions(), submitReviewDefinition(REVIEWER_OUTPUT_JSON_SCHEMA, "hunter")];
const result = await tools.execute({ name: "read_file", input: { path: "src/index.ts" } });
const audit = tools.audit(); // { substantiveCalls, totalCalls, filesRead, commandsRun }
```

## Tools

`read_file`, `list_dir`, `find_files`, `search` (ripgrep when installed, otherwise a JS fallback), `git_diff`, `git_log` and `git_blame`. `run_command` is added only when `allowedCommands` is non-empty.

## Proof of work (`audit()`)

- `totalCalls`: every `execute()` call, including failed ones.
- `substantiveCalls`: the number of **distinct, successful** calls to substantive tools that **returned content**.
  - "no matches", "no files match", "no commits", "no differences" and empty files do not count.
  - Repeats of the same normalised call count once.
  - `read_file` counts once per file, whatever range is read.
- `filesRead`: unique workspace-relative paths whose content was shown (`read_file`, `git_blame`).
- `commandsRun`: every `run_command` actually spawned, in order, including timeouts.

## Security model

- **Paths** are resolved against the realpath of the checkout. Escapes through `..`, absolute paths or symlinks are rejected, and so is `.git` in any case.
- **Never shown**, in every mode:
  - credential-shaped files: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`, `credentials*.json`, `.netrc`, `.npmrc`, `.pypirc`
  - untracked git-ignored files (a developer's local secrets in `--local` mode)
  - anything under `.git`
- **ripgrep** gets the model's glob *before* the exclusions, because in rg the last matching glob wins. Every result is also post-filtered.
- **Redaction**: all tool output passes through `redactSecrets` before it reaches the model. It covers API keys, GitHub/Slack/AWS tokens, PEM blocks, `Authorization:` values and `password=`/`token=` assignments.
- **Binaries**: `git`, `rg` and run_command executables are resolved once, to absolute paths, using only PATH entries that are absolute and outside the checkout. A PR-committed `node_modules/.bin/git` can never shadow them.
- **git** runs with an allowlisted environment:
  - only PATH, LANG, LC_ALL, TZ, SSH_AUTH_SOCK and SSH_AGENT_PID are kept; no inherited `GIT_*`
  - HOME is an empty private dir
  - `GIT_CONFIG_NOSYSTEM`, `GIT_NO_LAZY_FETCH`, `GIT_LITERAL_PATHSPECS`
  - pinned config: hooks off, fsmonitor off, `diff.external=`, `core.pager=cat`, `protocol.allow=never`, `credential.helper=`
  - `diff` always passes `--no-ext-diff --no-textconv`
  - Revisions are resolved to commit SHAs first, so a path posing as a revision cannot switch `git diff` into `--no-index` mode.

## `allowedCommands` executes PR code

`run_command` runs whatever the PR's `package.json`, `Makefile` or test files say. That code has network access and write access to the checkout. A linked worktree's `.git` file also points back at the source repository or mirror. Mitigations:

- Each call gets a scratch `HOME`, `XDG_*` and `TMPDIR`, removed afterwards.
- The environment is reduced to PATH (safe entries), LANG, CI and NODE_ENV.
- The whole process group is killed when the command returns or times out.
- Matching is **exact**. An entry ending in ` *` (e.g. `"npx vitest run *"`) admits extra arguments.
- The tokenizer rejects every shell metacharacter, even inside quotes.

**Only enable `allowedCommands` for trusted code, or inside a container/sandbox workspace.** Never enable it for untrusted forks on a host checkout.
