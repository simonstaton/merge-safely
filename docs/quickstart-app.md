# Quickstart: self-hosted GitHub App

The App is a small service you run yourself. It receives GitHub webhooks, runs reviews, and writes check runs and PR reviews. The maintainers do not run a shared instance. The full reference is [packages/app/README.md](../packages/app/README.md).

What the App adds over the Action:

- Sub-minute latency (no Actions cold start).
- One set of connections and budgets across many repositories.
- A durable SQLite store and cost ledger.
- Installation-wide budgets, including the monthly ceiling, with alerts.
- Escalation with a human-verdict path.
- A setup page for connections.

## 1. Create the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App** (under your organisation for an org-wide install).

| Setting | Value |
|---|---|
| Webhook URL | `https://<your-host>/webhooks/github` |
| Webhook secret | A long random string. You will set it as `GITHUB_WEBHOOK_SECRET`. |
| Setup URL (optional) | `https://<your-host>/setup` |

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

Subscribe to events: **Pull request**, **Check run**, **Check suite**. Installation events (`installation`, `installation_repositories`) are delivered to every App automatically.

Create the App, then generate a private key and note the App ID.

Generate a webhook secret, a master key and a setup token:

```bash
openssl rand -hex 32   # GITHUB_WEBHOOK_SECRET
openssl rand -hex 32   # MERGE_SAFELY_MASTER_KEY
openssl rand -hex 24   # SETUP_TOKEN
```

## 2. Run it with Docker Compose

Use [examples/app-docker-compose/](../examples/app-docker-compose/) (or `packages/app/`, which has the same `docker-compose.yml` and `.env.example`):

```bash
cp .env.example .env
$EDITOR .env
cp ~/Downloads/<your-app>.private-key.pem ./github-app.pem
chmod 0644 github-app.pem   # the container runs as uid 1000 and must be able to read it
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | yes | The App's numeric ID. |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_FILE` | one of | The App's private key: PEM contents, or a path to the `.pem` (the compose file mounts `./github-app.pem` and sets the path). |
| `GITHUB_WEBHOOK_SECRET` | yes | The webhook secret set on the App. Every webhook's signature is verified against it. |
| `MERGE_SAFELY_MASTER_KEY` | yes | Wraps the per-connection data keys. 64 hex characters, `base64:` plus 32 bytes, or a passphrase of at least 12 characters. The service refuses to start without it. |
| `SETUP_TOKEN` | yes | Bearer token for `/setup` and the admin endpoints. |
| `MERGE_SAFELY_DATA_DIR` | no | Default `/data`. Holds the SQLite database (`app.db`), repository mirrors and review worktrees. |
| `DATABASE` | no | Explicit database path. Default `$MERGE_SAFELY_DATA_DIR/app.db`. |
| `PORT` | no | HTTP port. Default `8080`. |
| `PUBLIC_URL` | no | Base URL of the service, used in the human-verdict instructions in escalation messages. |
| `SLACK_WEBHOOK_URL` | no | Slack incoming webhook for escalations, verdict notices and budget alerts (one channel per instance). |
| `CONCURRENCY` | no | Reviews running at once. Default `2`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Default `info`. |
| `SHUTDOWN_DEADLINE_MS` | no | How long running reviews get to finish on SIGTERM. Default `25000`. |
| `GITHUB_API_URL` | no | GitHub Enterprise Server API root. |

Keep the master key out of the data volume and out of backups of it. Losing the master key means re-connecting every provider. Leaking it together with the database exposes every stored key. To rotate it, run `merge-safely-app rotate-key` with `MERGE_SAFELY_MASTER_KEY_OLD` and the new `MERGE_SAFELY_MASTER_KEY` (see the App README).

### Endpoints

| Endpoint | Auth | Purpose | Expose to |
|---|---|---|---|
| `POST /webhooks/github` | webhook signature | GitHub webhook receiver. | The internet (GitHub must reach it). |
| `GET /setup` | `SETUP_TOKEN` bearer | Connections and budgets page. | Only the people who administer the install. |
| `GET /installations/<id>/prs/<n>?repo=owner/name` | `SETUP_TOKEN` bearer | Verdict, digest and history as JSON. | Operators. |
| `POST /installations/<id>/verdict` | `SETUP_TOKEN` bearer | Record a SHA-bound human verdict. | Operators. |
| `GET /healthz` | none | Liveness and queue depth. | Your load balancer or orchestrator. |
| `GET /metrics` | none | Prometheus metrics, including installation ids and spend. | Your internal monitoring only. |

Put a reverse proxy in front that forwards **only** `/webhooks/github` from the internet, and keep everything else on your own network (a VPN, an SSO proxy or an IP allowlist). A catch-all proxy rule would publish `/metrics` and `/healthz`. The App README has a Caddy and nginx example.

### Storage

SQLite runs in WAL mode. Keep `MERGE_SAFELY_DATA_DIR` on local disk; WAL does not work over network filesystems. Run a single replica per database. The ledger compacts old cost rows into per-change rollups, so sums stay exact and the table stays bounded.

## 3. Install the App and connect a model

Install the App on your organisation or selected repositories. GitHub redirects to the setup URL if you set one; otherwise open `https://<your-host>/setup` and enter the `SETUP_TOKEN`.

On the setup page:

1. Pick a provider and connection kind.
2. Paste a key, or enter a base URL for a compatible endpoint.
3. The page validates the connection immediately and lists the models it can reach.
4. Pick a default model, review the estimated cost per tier and the budget ceilings, and save.

Secrets are encrypted before they are stored and never returned by any endpoint after creation. To rotate a key, re-connect with the same connection id.

Connections belong to the installation. A repository's policy can only reference connections of its own installation. The policy is read from the PR's **base** branch, never from the PR itself.

## 4. Open a PR

Open a PR in an installed repository. The `merge-safely/verdict` check appears within seconds. Then make it required: [merge-bots.md](merge-bots.md).

## Escalation

When review does not converge within `rounds.max`, or at tier 3 for non-trusted authors (`trust.escalateTier3ForStandardAuthors`), the App escalates. With `SLACK_WEBHOOK_URL` set, a message with the digest, the top blockers and the resolve instruction goes to Slack. A person resolves with a SHA-bound human verdict through the App's API (the CLI's `merge-safely verdict` writes to the CLI's own store, not the App's):

```bash
curl -fsS -X POST "https://<your-host>/installations/<id>/verdict" \
  -H "Authorization: Bearer $SETUP_TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"my-org/my-repo","number":1234,"headSha":"<headSha>","decision":"pass","reason":"…","signedBy":"alice"}'
```

## Budgets

The gate enforces every ceiling when a review is admitted: per seat, per change, rolling window, all-time against its own ledger, and monthly per installation. The App also re-evaluates the installation ceilings at webhook intake, after each job and every minute, and sends edge-triggered alerts at 50, 80 and 100 percent. Ceilings set through the setup page persist across restarts (empty = never configured, `0` = disabled). See [budgets.md](budgets.md).

## Hardening checklist

- The container runs as a non-root user (uid 1000) with a read-only root filesystem in the example compose file.
- Reviewers read PR code. If any policy sets `runner.allowedCommands`, they also execute it. Treat the App host as exposed to PR authors and give it no credentials beyond the App key and model keys. See [security.md](security.md).
- Restrict outbound network from the container to GitHub and your model endpoints if your platform allows it.
- Back up the data volume and the master key separately.
- Uninstalling the App deletes that installation's stored keys, settings, repository mirrors and worktrees.
