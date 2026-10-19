# @merge-safely/app

The self-hosted Merge Safely GitHub App (design section 6.2): a small Node service that receives GitHub webhooks,
queues reviews durably in SQLite, runs the gate, and writes the `merge-safely/verdict` check run and PR review. It
ships a one-page setup UI for provider connections and budgets. No web framework, no external services besides
GitHub and your model providers.

## 1. Create the GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App** (under the organisation for an org-wide
install).

| Setting | Value |
| --- | --- |
| Homepage URL | anything, e.g. your repo |
| Webhook URL | `https://<your-host>/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` (this is `GITHUB_WEBHOOK_SECRET`) |
| Setup URL (optional) | `https://<your-host>/setup` (tick "Redirect on update") |

Permissions (least privilege, `APP_PERMISSIONS` in `@merge-safely/github`):

| Permission | Access | Why |
| --- | --- | --- |
| Checks | Read and write | the `merge-safely/verdict` check run, the merge signal |
| Pull requests | Read and write | PR metadata, files and commits; the review digest and inline comments |
| Contents | Read | diffs, `.merge-safely.yml` on the base branch, checkout of the head SHA |
| Metadata | Read | mandatory for every App |
| Members (organisation) | Read | **only** if a policy uses `trust.provider: github-teams` |

Subscribe to events: **Pull request**, **Check run**, **Check suite**. (`installation` and
`installation_repositories` are delivered to every App automatically; the service uses them to track installations.)

Create the App, note the **App ID**, and generate a **private key** (`.pem`).

## 2. Run it

```bash
cd packages/app
cp .env.example .env
openssl rand -hex 32   # -> MERGE_SAFELY_MASTER_KEY
openssl rand -hex 24   # -> SETUP_TOKEN
$EDITOR .env           # GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET, MERGE_SAFELY_MASTER_KEY, SETUP_TOKEN, PUBLIC_URL
cp ~/Downloads/<your-app>.private-key.pem ./github-app.pem
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

The compose file binds to `127.0.0.1:8080`. Put a TLS-terminating reverse proxy in front; only `/webhooks/github`
has to be reachable from GitHub. Keep `/setup` and `/installations/*` on your own network or behind SSO.

Without Docker: `npm ci && npm run build` at the repo root, then `node packages/app/dist/main.js` (bin
`merge-safely-app`) with the same environment. `git` must be on `PATH`.

## 3. First run

1. Install the App on your organisation or a few repositories. GitHub sends the `installation` webhook and the
   installation appears on the setup page (GitHub's redirect to the Setup URL lands there too).
2. Open `https://<your-host>/setup` and paste the `SETUP_TOKEN` into the token box (it is kept in that browser tab
   only and sent as an `Authorization: Bearer` header; there are no cookies).
3. **Add a connection**: pick a provider and kind, paste the key (or a base URL for a compatible endpoint), optionally
   a default model, and press **Validate and save**. The page calls the provider's `validate` immediately, lists the
   models the key can reach and the estimated cost per tier for a typical 300-line PR, then stores the key encrypted.
4. Optionally set **budget ceilings** for the installation.
5. Reference the connection id from the repository's `.merge-safely.yml` on its default branch (or rely on the default
   panel), then open a PR. The `merge-safely/verdict` check appears within seconds.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | yes | | the App's numeric id |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_FILE` | one of | | PEM contents (`\n` escapes allowed), or a path to the `.pem` |
| `GITHUB_WEBHOOK_SECRET` | yes | | the App's webhook secret (16+ chars) |
| `MERGE_SAFELY_MASTER_KEY` | yes | | wraps every stored secret; 64 hex chars, `base64:`+32 bytes, or a 12+ char passphrase. The service refuses to start without it |
| `SETUP_TOKEN` | yes | | bearer token for `/setup` and the admin endpoints (16+ chars) |
| `MERGE_SAFELY_DATA_DIR` | no | `/data` | SQLite database `app.db`, repo mirrors (`repos/`), review worktrees (`worktrees/`) |
| `PORT` | no | `8080` | HTTP port |
| `PUBLIC_URL` | no | | base URL for check-run "Details" links (`/installations/<id>/prs/<n>`) |
| `SLACK_WEBHOOK_URL` | no | | Slack incoming webhook: escalations, verdict notices, budget alerts |
| `CONCURRENCY` | no | `2` | reviews running at once (one per PR at a time) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE` | no | `$MERGE_SAFELY_DATA_DIR/app.db` | explicit database path |
| `SHUTDOWN_DEADLINE_MS` | no | `25000` | how long running reviews get to finish on SIGTERM |
| `GITHUB_API_URL` | no | | GitHub Enterprise Server API root, e.g. `https://ghe.example.com/api/v3` |

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /webhooks/github` | webhook signature | verify `X-Hub-Signature-256`, dedupe by `X-GitHub-Delivery`, enqueue, answer `202` |
| `GET /healthz` | none | `200` with queue depth |
| `GET /metrics` | none | Prometheus text: jobs by state, queue depth, verdicts by decision/tier, spend by installation, webhooks, retries |
| `GET /setup?installation=<id>` | bearer | setup page; `POST /setup/connections`, `/setup/connections/delete`, `/setup/budget` |
| `GET /installations/<id>/prs/<n>?repo=owner/name` | bearer | verdict, digest and history (JSON) |
| `POST /installations/<id>/verdict` | bearer | record a SHA-bound human verdict |

`/metrics` exposes installation ids and spend; keep it on the internal network.

Human verdict (a human `pass` replaces a machine block for that exact SHA, with provenance):

```bash
curl -fsS -X POST "$PUBLIC_URL/installations/123/verdict" \
  -H "Authorization: Bearer $SETUP_TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"my-org/my-repo","number":42,"headSha":"<40-char sha>","decision":"pass","reason":"verified the migration by hand","signedBy":"alice"}'
```

## How it behaves

- **Policy comes from the base branch.** `.merge-safely.yml` is read at the PR's base ref, never at the head SHA, so a
  PR (including one from a fork) cannot loosen its own review. An invalid policy fails the check run with the errors
  and calls no model. The base ref and policy hash are recorded on the job.
- **Durable queue.** Jobs live in SQLite keyed (installation, repo, PR, head SHA). Duplicate events coalesce; a push
  supersedes a queued job for the older SHA, and a running one is marked superseded when it finishes (the gate has no
  cancellation hook). One review per PR runs at a time. Transient failures (GateError `source`, `internal`,
  `store-conflict`, GitHub 5xx/429) retry with exponential backoff (30 s, 60 s, 120 s; 3 retries); `seating`, `policy`
  and `budget` errors fail at once with the message on the check run. Jobs interrupted by a crash or a shutdown past
  its deadline are re-queued at boot.
- **Budgets.** Every ceiling is enforced by the gate at admission. Installation ceilings (rolling window, all-time,
  monthly) are also re-evaluated at webhook intake, after each job and every minute, with edge-triggered alerts at
  50/80/100% to the log and Slack. Setup-page overrides persist: empty = never configured (the repo policy or the
  default applies), `0` = explicitly disabled, any other number replaces the policy value. A corrupt stored value falls
  back to "never configured" with a logged error.
- **Credential custody.** Each secret is envelope-encrypted (a random data key per blob, wrapped by the master key)
  with additional authenticated data `<installationId>:<connectionId>`, so a blob copied to another installation or
  connection will not decrypt. Secrets are never returned after creation (the page shows a masked tail), never
  logged, and scrubbed from every log line along with the webhook secret, master key, setup token, App key and
  installation tokens. Uninstalling the App purges that installation's connections and settings.
- **Checkouts.** Repositories are mirrored under `$MERGE_SAFELY_DATA_DIR/repos/<installation>/` and each seat gets a
  disposable worktree. The installation token is passed to git as a scoped `http.extraheader` via the environment,
  never in the clone URL or argv.
- **Storage.** One SQLite file (WAL): the App's tables (`installations`, `connections`, `settings`, `jobs`,
  `deliveries`) and the `@merge-safely/store-sqlite` verdict store and cost ledger, which is the store of record.
  Local disk only. Back up the data volume and the master key separately.

## Hardening

- Reviewers read PR code, and execute it if a policy sets `runner.allowedCommands`. Treat the host as exposed to PR
  authors: give it nothing beyond the App key and model keys, and restrict outbound network to GitHub and your model
  endpoints where your platform allows.
- The compose file runs the container read-only, as the unprivileged `node` user, with `no-new-privileges`.
