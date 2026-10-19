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
chmod 0644 github-app.pem   # the container runs as uid 1000; or chown 1000 it and keep 0600
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

The compose file binds to `127.0.0.1:8080`. Put a TLS-terminating reverse proxy in front that forwards **only**
`/webhooks/github` from the internet; `/setup`, `/installations/*`, `/metrics` and `/healthz` stay on your own
network (or behind SSO). `/metrics` and `/healthz` are unauthenticated, and `/metrics` exposes installation ids and
spend, so a catch-all proxy rule would publish them. A Caddy example:

```caddyfile
merge-safely.example.com {
  @webhook path /webhooks/github
  handle @webhook {
    reverse_proxy 127.0.0.1:8080
  }
  handle {
    respond 404
  }
}
```

nginx equivalent: `location = /webhooks/github { proxy_pass http://127.0.0.1:8080; }` and `location / { return 404; }`.

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
5. Reference the connection id from `.merge-safely.yml` on the branch your PRs target (the policy is always read from
   the PR's **base** branch), or rely on the default panel, then open a PR. The `merge-safely/verdict` check appears within seconds.

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
| `PUBLIC_URL` | no | | base URL of this service, used in the human-verdict instructions in escalation messages |
| `SLACK_WEBHOOK_URL` | no | | Slack incoming webhook: escalations, verdict notices, budget alerts. One channel for the whole instance: run one instance per tenant if installations must not see each other's PR titles |
| `CONCURRENCY` | no | `2` | reviews running at once (one per PR at a time) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE` | no | `$MERGE_SAFELY_DATA_DIR/app.db` | explicit database path |
| `SHUTDOWN_DEADLINE_MS` | no | `25000` | how long running reviews get to finish on SIGTERM (0-600000); keep the container stop grace period above it |
| `GITHUB_API_URL` | no | | GitHub Enterprise Server API root, e.g. `https://ghe.example.com/api/v3` |

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /webhooks/github` | webhook signature | verify `X-Hub-Signature-256`, dedupe by `X-GitHub-Delivery`, enqueue, answer `202` |
| `GET /healthz` | none | `200` with queue depth |
| `GET /metrics` | none | Prometheus text: jobs by state, queue depth, verdicts by decision/tier, spend by installation, webhooks, retries |
| `GET /setup?installation=<id>` | bearer | setup page; `POST /setup/connections`, `/setup/connections/delete`, `/setup/budget` |
| `GET /installations/<id>/prs/<n>?repo=owner/name` | bearer | verdict, digest and history (JSON); read-only, mints no token and calls no provider |
| `POST /installations/<id>/verdict` | bearer | record a SHA-bound human verdict |

`/metrics` and `/healthz` are unauthenticated; `/metrics` exposes installation ids and spend. Keep both internal (see
the proxy example above). The check run's "Details" link is GitHub's default (the PR); the explain endpoint needs the
bearer token, so it is for operators and scripts, not for clicks from GitHub.

Human verdict (a human `pass` replaces a machine block for that exact SHA, with provenance):

```bash
curl -fsS -X POST "$PUBLIC_URL/installations/123/verdict" \
  -H "Authorization: Bearer $SETUP_TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"my-org/my-repo","number":42,"headSha":"<40-char sha>","decision":"pass","reason":"verified the migration by hand","signedBy":"alice"}'
```

`headSha` must be the PR's current head (`409 stale-head-sha` otherwise; `"allowStaleSha": true` records it anyway
with a warning appended to the reason), and `signedBy` must not be the PR's author (`403 signer-is-author`).

## How it behaves

- **Policy comes from the base branch.** `.merge-safely.yml` is read at the PR's base ref, never at the head SHA, so a
  PR (including one from a fork) cannot loosen its own review. An invalid policy fails the check run with the errors
  and calls no model. The base ref and policy hash are recorded on the job.
- **Retargets get a fresh review.** A `pull_request.edited` that changes the base never coalesces into an open job
  (that job read policy from the old base). It enqueues a new job, supersedes the open ones, and the gate runs with
  `trigger: "base-changed"` under the new base's policy. Each job records its base ref, policy source and policy hash.
- **Durable queue.** Jobs live in SQLite keyed (installation, repo, PR, head SHA, base ref). Duplicate events
  coalesce; a push supersedes a queued job for the older SHA, and a running one is marked superseded when it finishes
  (the gate has no cancellation hook). Closing or merging a PR cancels its queued jobs; suspending the installation
  fails them. One review per PR runs at a time.
- **Retries.** Transient failures retry with exponential backoff (30 s, 60 s, 120 s; 3 retries): GateError
  `source`, `internal`, `store-conflict`, network errors, GitHub 5xx and 429, and a 403 only when it is rate limiting
  (`x-ratelimit-remaining: 0`, `retry-after`, or the secondary-rate-limit message; `retry-after` / the reset time is
  honoured). Permission and suspended-installation 403s, other 4xx, and `seating` / `policy` / `budget` errors fail at
  once with the message on the check run.
- **Restarts.** Jobs interrupted by a crash or a shutdown past its deadline are re-queued at boot, except superseded
  ones (marked superseded, never re-reviewed). A job found running at boot counts the interrupted run as an attempt;
  after 3 attempts it is marked failed ("crashed repeatedly") and the check run fails, so a job that kills the process
  cannot crash-loop the service. At boot the service also lists the App's installations from GitHub, so installs made
  before it first ran show up; webhooks for unknown or uninstalled installations are ignored with a log line.
- **Single replica.** Run one instance per database file. Claims are IMMEDIATE transactions, but the in-process
  worker, alert latch and per-PR serialisation assume one process.
- **Budgets.** Every ceiling is enforced by the gate at admission. Installation ceilings (rolling window, all-time,
  monthly over a rolling 30 days, the same window the gate uses) are also re-evaluated at webhook intake, after each job and every minute, with edge-triggered alerts at
  50/80/100% to the log and Slack. Setup-page overrides persist: empty = never configured (the repo policy or the
  default applies), `0` = explicitly disabled, any other number replaces the policy value. A corrupt stored value falls
  back to "never configured" with a logged error.
- **Credential custody.** Each secret is envelope-encrypted (a random data key per blob, wrapped by the master key)
  with additional authenticated data `<installationId>:<connectionId>`, so a blob copied to another installation or
  connection will not decrypt. Secrets are never returned after creation (the page shows a masked tail), never
  logged, and scrubbed from every log line along with the webhook secret, master key, setup token, App key and
  installation tokens (recent literals are kept in a bounded set; token shapes are also matched by pattern; JSON-escaped
  forms are matched too). A passphrase master key is stretched with scrypt once at boot (per-deployment salt), not
  per request; a 64-hex key skips that entirely.
- **Uninstall.** Removing the App purges the installation's connections and settings and deletes its repository
  mirrors and worktrees (`$MERGE_SAFELY_DATA_DIR/repos/<id>/`, `worktrees/<id>/`; best effort, logged). Removing
  repositories from an installation deletes their mirrors and fails their queued jobs.
- **Master-key rotation.** Stop the service, then run it once with both keys:

  ```bash
  docker compose run --rm -e MERGE_SAFELY_MASTER_KEY_OLD=<old> -e MERGE_SAFELY_MASTER_KEY=<new> \
    merge-safely node packages/app/dist/main.js rotate-key
  ```

  It decrypts every stored connection with the old key and re-encrypts it with the new one (each row is atomic and
  the command can be re-run). Then put the new key in `.env` and start the service.
- **Checkouts.** Repositories are mirrored under `$MERGE_SAFELY_DATA_DIR/repos/<installation>/` and each seat gets a
  disposable worktree under `worktrees/<installation>/`. The installation token is passed to git as a scoped `http.extraheader` via the environment,
  never in the clone URL or argv.
- **Storage.** One SQLite file (WAL): the App's tables (`installations`, `connections`, `settings`, `jobs`,
  `deliveries`) and the `@merge-safely/store-sqlite` verdict store and cost ledger, which is the store of record.
  Local disk only. Back up the data volume and the master key separately.

## Hardening

- Reviewers read PR code, and execute it if a policy sets `runner.allowedCommands`. Treat the host as exposed to PR
  authors: give it nothing beyond the App key and model keys, and restrict outbound network to GitHub and your model
  endpoints where your platform allows.
- The compose file runs the container read-only, as the unprivileged `node` user (uid 1000), with
  `no-new-privileges`. The image contains only each package's `package.json` and `dist/` plus production
  `node_modules`; `.env` files and `*.pem` keys are excluded from the build context by `.dockerignore`.
