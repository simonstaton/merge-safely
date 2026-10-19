# Creator API

Service that powers creator profiles, posts and subscriptions.

## Getting started

Requires Node 20 and a local Postgres (see [docs/setup.md](docs/setup.md)).

```sh
npm install
cp .env.example .env
npm run dev
```

The API listens on port 3000 by default; set `PORT` to change it.

## Tests

```sh
npm test            # unit tests
npm run test:e2e    # needs the dev database running
```
