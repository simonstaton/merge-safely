# @merge-safely/escalation-slack

Slack [incoming webhook](https://api.slack.com/messaging/webhooks) adapters for the `Escalation` and `Reporter` ports.

```ts
import { slackEscalation, slackReporter } from "@merge-safely/escalation-slack";

const escalation = slackEscalation({ webhookUrl: process.env.SLACK_WEBHOOK_URL!, channelHint: "#code-review" });
const reporter = slackReporter({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }); // verdict, escalated, budget-blocked, error
```

## Escalation

`request(verdict, digest)` posts a Block Kit message with the digest headline, the PR link, tier, machine decision,
quorum, head SHA, the top five confirmed blockers and the command a human runs to resolve it:

```
merge-safely verdict --repo <owner>/<repo> --pr <N> --sha <headSha> --pass|--block
```

It returns `{ id, createdAt }` where `id` is a locally generated UUID. **Incoming webhooks return no message id or
permalink**, so the handle has no `url`, and `resolve` is not implemented: webhooks are write-only. The human verdict
is SHA-bound and lands in the verdict store; the gate reads it from there. For threaded updates or in-Slack buttons, a
future adapter using a bot token and `chat.postMessage` can fill in `url` and `resolve`.

`channelHint` only appears in the message context. A webhook is bound to the channel chosen when it was created.

## Reporter

Posts one short line per event. Default events: `verdict`, `escalated`, `budget-blocked`, `error`. `pending` is never
posted, even when listed in `events`. `report` never throws: failures are logged through `logger.warn` (default
`console.warn`) and swallowed so Slack cannot break a review. `request` on the escalation does throw
(`SlackWebhookError`) so the caller knows nobody was notified.

## Behaviour shared by both

- The webhook URL is a secret. It is never logged and is scrubbed from every error message (the full URL, its path,
  and anything shaped like a `hooks.slack.com` URL).
- Each attempt times out after 10 s (`timeoutMs` to change). One retry on a 5xx or a network error; 4xx and timeouts
  are not retried.
- PR titles, finding titles and error strings are untrusted. They are escaped (`&`, `<`, `>`) so they cannot inject
  `<!channel>` pings or links, and truncated to Block Kit limits.
- Pass `fetch` to inject a client (tests use a fake; nothing touches the network).
