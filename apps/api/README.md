# API

`bun run dev` starts the local Cloudflare Worker on port 3000 and the web app.
The local Worker uses D1 under `apps/api/.wrangler/state`. Before its first run,
apply the checked-in migration:

```sh
bun run --cwd apps/api db:migrate:local
bun run --cwd apps/api db:smoke:local
```

The smoke command starts its own Worker on port 3102, writes a D1 row, reads it
through another request, and stops the Worker. It also applies any pending local
migrations. Use `bun run --cwd apps/api db:generate` after changing
`src/db/schema.ts`; commit the generated SQL and Drizzle metadata together.

`wrangler.local.jsonc` supplies only the local D1 binding. Hosted D1 setup is
tracked in [ADI-195](https://linear.app/0xpratik/issue/ADI-195/configure-hosted-d1-for-the-production-lanatools-worker).

`src/worker.ts` is the deployed Worker. `src/worker.local.ts` adds the database
smoke routes to the local Worker only. `src/index.ts` still serves the API on Bun
for the existing health test and manual startup; it does not have D1.
