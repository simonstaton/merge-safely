# Quickstart: self-hosted GitHub App

The App is a small service you run yourself. It receives GitHub webhooks, runs reviews, and writes check runs and PR reviews. The maintainers do not run a shared instance. The full reference is [packages/app/README.md](../packages/app/README.md).

What the App adds over the Action:

- Sub-minute latency (no Actions cold start).
- One set of connections and budgets across many repositories.
- A durable review queue, verdict store and cost ledger in one SQLite file.
- Installation-wide budgets, including the monthly ceiling (advisory in the Action), with alerts.
- Escalation with a human-verdict API.
- A setup page for connections and budget ceilings.

## 1. Create the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App** (under your organisation for an org-wide install).

| Setting | Value |
|---|---|
| Webhook URL | `https://<your-host>/webhooks/github` |
| Homepage URL | Anything, for example your repository. |
| Webhook secret | A random string of at least 16 characters. You will set it as `GITHUB_WEBHOOK_SECRET`. |
| Setup URL (optional) | `https://<your-host>/setup` (tick "Redirect on update"). |

Repository permissions:

| Permission | Access | Why |
|---|---|---|
| Checks | Read and write | The verdict check run. |
| Pull requests | Read and write | Read the PR; post the review and inline comments. |
| Contents | Read | Read `.merge-safely.yml` from the PR's base branch; check out the head SHA. |
| Metadata | Read | Required by GitHub for every App. |

Organisation permissions:

| Permission | Access | Why |
|---|---|---|
| Members | Read | Only if the policy uses `trust.provider: github-teams`. Leave it off otherwise. |

Subscribe to events: **Pull request**, **Check run**, **Check suite**. Installation events (`installation`, `installation_repositories`) are delivered to every App automatically; the service uses them to track installations, and at boot it also lists the App's existing installations from GitHub.

Create the App, then generate a private key and note the App ID.

Generate a webhook secret, a master key and a setup token:

```bash
openssl rand -hex 32   # GITHUB_WEBHOOK_SECRET
openssl rand -hex 32   # MERGE_SAFELY_MASTER_KEY
openssl rand -hex 24   # SETUP_TOKEN
```

## 2. Run it with Docker Compose

From a checkout of this repository, use [examples/app-docker-compose/](../examples/app-docker-compose/) or `packages/app/`, which hold the same `docker-compose.yml` and `.env.example`. The compose file builds the image from the repository root and binds to `127.0.0.1:8080`.

```bash
git clone https://github.com/simonstaton/merge-safely.git
cd merge-safely/examples/app-docker-compose
cp .env.example .env
$EDITOR .env
cp ~/Downloads/<your-app>.private-key.pem ./github-app.pem
chmod 0644 github-app.pem   # the container runs as uid 1000 and must be able to read it
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz      # {"ok":true,"queue":{"queued":0,"running":0},"inFlight":0}
```

Without Docker: `npm ci && npm run build` at the repository root, then `node packages/app/dist/main.js` (bin `merge-safely-app`) with the same environment. `git` must be on `PATH`, and `ripgrep` is used when installed.

The service validates its configuration at boot and refuses to start, with exit code 2 and a message naming each bad variable, when anything is missing or malformed.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | yes | The App's numeric ID. |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_FILE` | one of | The App's private key: PEM contents, or a path to the `.pem` (the compose file mounts `./github-app.pem` and sets the path). |
| `GITHUB_WEBHOOK_SECRET` | yes | The webhook secret set on the App, at least 16 characters. Every webhook's `X-Hub-Signature-256` is verified against it. |
| `MERGE_SAFELY_MASTER_KEY` | yes | Wraps the per-connection data keys. 64 hex characters, `base64:` plus 32 bytes, or a passphrase of at least 12 characters. The service refuses to start without it. |
| `SETUP_TOKEN` | yes | Bearer token for `/setup` and the admin endpoints, at least 16 characters. |
| `MERGE_SAFELY_DATA_DIR` | no | Default `/data`. Holds the SQLite database (`app.db`), repository mirrors (`repos/`) and review worktrees (`worktrees/`). |
| `DATABASE` | no | Explicit database path. Default `$MERGE_SAFELY_DATA_DIR/app.db`. |
| `PORT` | no | HTTP port. Default `8080`. |
| `PUBLIC_URL` | no | Base URL of the service, used in the human-verdict instructions in escalation messages. |
| `SLACK_WEBHOOK_URL` | no | Slack incoming webhook for escalations, verdict notices and budget alerts (one channel per instance). |
| `CONCURRENCY` | no | Reviews running at once, 1 to 32 (one per PR at a time). Default `2`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Default `info`. |
| `SHUTDOWN_DEADLINE_MS` | no | How long running reviews get to finish on SIGTERM, 0 to 600000. Default `25000`. Keep the container stop grace period above it (the compose file uses 30 s). |
| `GITHUB_API_URL` | no | GitHub Enterprise Server API root, for example `https://ghe.example.com/api/v3`. |

Keep the master key out of the data volume and out of backups of it. Losing the master key means re-connecting every provider. Leaking it together with the database exposes every stored key. To rotate it, stop the service and run it once with both keys, then put the new key in `.env` and start it again:

```bash
docker compose run --rm -e MERGE_SAFELY_MASTER_KEY_OLD=<old> -e MERGE_SAFELY_MASTER_KEY=<new> \
  merge-safely node packages/app/dist/main.js rotate-key
```

### Endpoints

| Endpoint | Auth | Purpose | Expose to |
|---|---|---|---|
| `POST /webhooks/github` | webhook signature | GitHub webhook receiver. | The internet (GitHub must reach it). |
| `GET /setup?installation=<id>` | `SETUP_TOKEN` bearer | Connections and budgets page. Forms post to `/setup/connections`, `/setup/connections/delete` and `/setup/budget`. | Only the people who administer the install. |
| `GET /installations/<id>/prs/<n>?repo=owner/name` | `SETUP_TOKEN` bearer | Verdict, digest and history as JSON. Read-only; calls no model. | Operators. |
| `POST /installations/<id>/verdict` | `SETUP_TOKEN` bearer | Record a SHA-bound human verdict. | Operators. |
| `GET /healthz` | none | `200` with queue depth and in-flight jobs. | Your load balancer or orchestrator. |
| `GET /metrics` | none | Prometheus metrics, including installation ids and spend. | Your internal monitoring only. |

The webhook endpoint answers `401` on a bad signature and `405` to anything but `POST`. The bearer endpoints answer `401` without the token and `404` for an installation the service does not know. Anything else is `404`.

Put a TLS-terminating reverse proxy in front that forwards **only** `/webhooks/github` from the internet, and keep everything else on your own network (a VPN, an SSO proxy or an IP allowlist). A catch-all proxy rule would publish `/metrics` and `/healthz`. A Caddy example:

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

### Storage

One SQLite file in WAL mode holds the App's tables (installations, connections, settings, jobs, deliveries) and the `@merge-safely/store-sqlite` verdict store and cost ledger, which is the store of record. Keep `MERGE_SAFELY_DATA_DIR` on local disk; WAL does not work over network filesystems. Run a single replica per database. The ledger compacts old cost rows into per-change rollups, so per-change and all-time sums stay exact and the table stays bounded.

Jobs are durable: duplicate events coalesce, a push supersedes a queued job for an older SHA, closing a PR cancels its queued jobs, and jobs interrupted by a restart are re-queued at boot (a job that crashed the process three times is failed instead). Transient failures (GitHub 5xx and rate limits, network errors, store conflicts) retry with backoff; configuration errors (seating, policy, budget) fail at once with the message on the check run.

## 3. Install the App and connect a model

Install the App on your organisation or selected repositories. GitHub sends the `installation` webhook and the installation appears on the setup page. GitHub redirects to the setup URL if you set one; otherwise open `https://<your-host>/setup` and paste the `SETUP_TOKEN` into the token box. The token is kept in that browser tab only and sent as an `Authorization: Bearer` header; there are no cookies.

On the setup page:

1. Pick a provider and connection kind.
2. Paste a key, or enter a base URL for a compatible endpoint, and optionally a default model.
3. Press **Validate and save**. The page validates the connection immediately, lists the models it can reach and the estimated cost per tier for a typical 300-line PR, then stores the key encrypted.
4. Optionally set the installation's budget ceilings.

Secrets are encrypted before they are stored (per secret, bound to `<installationId>:<connectionId>`), never returned by any endpoint after creation (the page shows a masked tail) and scrubbed from every log line. To rotate a key, re-connect with the same connection id.

Connections belong to the installation. A repository's policy can only reference connections of its own installation. The policy is read from the PR's **base** branch, never from the PR itself, and an invalid policy fails the check run with the errors and calls no model. A PR whose base is changed gets a fresh full review under the new base's policy.

## 4. Open a PR

Reference the connection id from `.merge-safely.yml` on the branch your PRs target, or rely on automatic model choice, then open a PR in an installed repository. The `merge-safely/verdict` check appears within seconds. Draft PRs are reviewed when they are marked ready. Then make the check required: [merge-bots.md](merge-bots.md).

## Escalation

The App escalates a commit once when `rounds.max` reviewed commits are used up, when a review cannot decide (pending), when a non-trusted author's tier 3 change blocks (`trust.escalateTier3ForStandardAuthors`), or when a blocked author's change does not pass. A trusted author at or below `trust.trustedBypassMaxTier` is never escalated. With `SLACK_WEBHOOK_URL` set, a message with the digest headline, the top blockers and the resolve instruction goes to Slack (verdicts, budget refusals and errors are posted as one-line notices too). Without it, escalations are only recorded on the verdict.

A person resolves with a SHA-bound human verdict through the App's API. The CLI's `merge-safely verdict` writes to the CLI's own store, not the App's. A human `pass` replaces a machine block for that exact SHA:

```bash
curl -fsS -X POST "https://<your-host>/installations/<id>/verdict" \
  -H "Authorization: Bearer $SETUP_TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"my-org/my-repo","number":1234,"headSha":"<full 40-char sha>","decision":"pass","reason":"verified the migration by hand","signedBy":"alice"}'
```

`headSha` must be a full SHA, `reason` at least 3 characters and `signedBy` a GitHub login. The response is `201` with the recorded verdict. Unlike the CLI's `verdict` command, the API takes `signedBy` as given and does not check that `headSha` is the PR's current head or that the signer is not the PR's author, so anyone holding `SETUP_TOKEN` can sign as anyone. Keep the token to the people allowed to sign, and sign the current head.

## Budgets

The gate enforces every ceiling when a review is admitted: per seat, per change, rolling window, all-time against its own ledger, and monthly per installation. The App also re-evaluates the installation ceilings at webhook intake, after each job and every minute, and sends edge-triggered alerts at 50, 80 and 100 percent. Ceilings set through the setup page persist across restarts (empty = never configured, `0` = disabled). See [budgets.md](budgets.md).

## Hardening checklist

- The example compose file runs the container read-only, as the unprivileged `node` user (uid 1000), with `no-new-privileges`. The image contains only each package's `package.json` and `dist/` plus production dependencies; `.env` files and `*.pem` keys are excluded from the build context.
- Reviewers read PR code. If any policy sets `runner.allowedCommands`, they also execute it. Treat the App host as exposed to PR authors and give it no credentials beyond the App key and model keys. See [security.md](security.md).
- Restrict outbound network from the container to GitHub and your model endpoints if your platform allows it.
- Back up the data volume and the master key separately.
- Uninstalling the App deletes that installation's stored keys, settings, repository mirrors and worktrees.
