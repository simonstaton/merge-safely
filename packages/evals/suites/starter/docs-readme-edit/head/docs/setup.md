# Local setup

1. Start Postgres with `docker compose up db`.
2. Run migrations with `npm run db:migrate`.
3. Seed demo data with `npm run db:seed` (optional).

If the API cannot connect, check `DATABASE_URL` in `.env`.
