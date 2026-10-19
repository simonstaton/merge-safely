# Quickstart: self-hosted GitHub App

The App is a small service you run yourself. It receives GitHub webhooks, runs reviews, and writes check runs and PR reviews. The maintainers do not run a shared instance.

What the App adds over the Action:

- Sub-minute latency (no Actions cold start).
- One policy and one set of connections across many repositories.
- A durable SQLite store and cost ledger.
- Enforced installation-wide budgets, including the monthly ceiling.
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
| Contents | Read | Check out the head SHA. |
| Metadata | Read | Required by GitHub for every App. |

Organisation permissions:

| Permission | Access | Why |
|---|---|---|
| Members | Read | Only if the policy uses `trust.provider: github-teams`. Leave it off otherwise. |

Subscribe to events: **Pull request**, **Push**, **Check suite**.

Create the App, then generate a private key and note the App ID.

Generate a webhook secret and a master key:

```bash
openssl rand -hex 32   # GITHUB_WEBHOOK_SECRET
openssl rand -hex 32   # MERGE_SAFELY_MASTER_KEY
```

## 2. Run it with Docker Compose

Copy [examples/app-docker-compose/](../examples/app-docker-compose/) and fill in `.env`:

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
curl -fsS http://localhost:3000/healthz
```

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | yes | The App's numeric ID. |
| `GITHUB_APP_PRIVATE_KEY` | yes | The App's private key, PEM contents. |
| `GITHUB_WEBHOOK_SECRET` | yes | The webhook secret set on the App. Every webhook's signature is verified against it. |
| `MERGE_SAFELY_MASTER_KEY` | yes | Wraps the per-connection data keys. 64 hex characters, `base64:` plus 32 bytes, or a passphrase of at least 12 characters. |
| `DATABASE` | yes | Path to the SQLite database file, on local disk. |
| `PORT` | no | HTTP port to listen on. |

Keep the master key out of the database volume and out of backups of it. Losing the master key means re-connecting every provider. Leaking it together with the database exposes every stored key.

### Endpoints

| Endpoint | Purpose | Expose to |
|---|---|---|
| `POST /webhooks/github` | GitHub webhook receiver. | The internet (GitHub must reach it). |
| `GET /setup` | Connections page. | Only the people who administer the install. |
| `GET /healthz` | Liveness check. | Your load balancer or orchestrator. |

Put `/setup` behind your own access control: a VPN, an SSO proxy, or an IP allowlist. Only `/webhooks/github` needs to be public.

### Storage

SQLite runs in WAL mode. Use local disk for `DATABASE`; WAL does not work over network filesystems. The ledger supports compacting old cost rows into per-change rollups, so sums stay exact and the table stays bounded.

## 3. Install the App and connect a model

Install the App on your organisation or selected repositories. GitHub redirects to the setup URL if you set one; otherwise open `https://<your-host>/setup`.

On the setup page:

1. Pick a provider and connection kind.
2. Paste a key, or enter a base URL for a compatible endpoint.
3. The page validates the connection immediately and lists the models it can reach.
4. Pick a default model, review the estimated cost per tier and the budget ceiling, and save.

Secrets are encrypted before they are stored and never returned by any endpoint after creation. To rotate a key, re-connect.

Connections belong to the installation. A repository's policy can only reference connections of its own installation.

## 4. Open a PR

Open a PR in an installed repository. The `merge-safely/verdict` check appears within seconds. Then make it required: [merge-bots.md](merge-bots.md).

## Escalation

When review does not converge within `rounds.max`, or at tier 3 for non-trusted authors (`trust.escalateTier3ForStandardAuthors`), the App escalates. With the Slack adapter, a message with the digest, the top blockers and the resolve command goes to a Slack incoming webhook. A person resolves with a SHA-bound human verdict:

```bash
merge-safely verdict --repo my-org/my-repo --pr 1234 --sha <headSha> --decision pass --reason "…"
```

## Budgets

The App enforces every ceiling at webhook intake and on a timer: per seat, per change, rolling window, all-time against its own ledger, and monthly per installation. Ceilings set through the setup page persist across restarts. See [budgets.md](budgets.md).

## Hardening checklist

- Run the container as a non-root user with a read-only root filesystem where possible.
- Reviewers read PR code. If any policy sets `runner.allowedCommands`, they also execute it. Treat the App host as exposed to PR authors and give it no credentials beyond the App key and model keys. See [security.md](security.md).
- Restrict outbound network from the container to GitHub and your model endpoints if your platform allows it.
- Back up `DATABASE` and the master key separately.
