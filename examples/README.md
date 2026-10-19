# Examples

| Directory | What it shows |
|---|---|
| [action-minimal/](action-minimal/) | The smallest working Action workflow: one Anthropic key, default policy. |
| [action-multi-provider/](action-multi-provider/) | Anthropic and OpenAI with decorrelated hunters and a fallback connection. |
| [policies/](policies/) | Complete `.merge-safely.yml` files: strict monorepo, small library, UI app. |
| [mergify/](mergify/) | Mergify queue rules gated on the verdict check. |
| [rulesets/](rulesets/) | A GitHub ruleset that requires the verdict check, and how to pin its source app. |
| [local-precommit/](local-precommit/) | A pre-push hook that runs `merge-safely run --local`. |
| [app-docker-compose/](app-docker-compose/) | Docker Compose and `.env` for the self-hosted GitHub App. |
| [programmatic/](programmatic/) | A type-checked program that wires `createGate` from the packages and reviews one PR. |

Guides are in [docs/](../docs/).
