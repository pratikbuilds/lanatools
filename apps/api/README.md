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

`wrangler.local.jsonc` supplies the local D1 binding. The hosted API Worker
uses `lanatools-production` through `wrangler.jsonc`. Apply new migrations with
`bun run --cwd apps/api db:migrate:remote` before deploying code that needs them.

`src/worker.ts` is the deployed Worker. `src/worker.local.ts` adds the database
smoke routes to the local Worker only. `src/index.ts` still serves the API on Bun
for the existing health test and manual startup; it does not have D1.

## Early-access list

`POST /api/early-access` accepts `{ "email": "you@example.com" }`. The shared
contract trims and lowercases the email and rejects invalid input. D1 stores
one row per normalized email in `early_access_signup`, with its first signup
timestamp. Both fresh signups and duplicates return
`{ "status": "joined", "email": "..." }` after the write completes, so the public
response does not reveal list membership. Database failures return an
error, never a signup confirmation. The endpoint does not send email.

The API uses the native Workers `SIGNUP_LIMITER` binding, configured in both
local and hosted Wrangler files, to allow 20 attempts per IP per minute per
Cloudflare location. Cloudflare supplies `CF-Connecting-IP`; local requests
without that header share a local bucket. This limits single-source spam,
though the platform limit is approximate and distributed callers can use
multiple IPs. Shared networks also share the allowance. A rejected request
returns 429 and `Retry-After: 60`, before writing to D1. No extra credentials
or separately provisioned service are required.

The landing forms share pending and confirmed state in memory. Failure
messages stay with the submitting form and its retained input. A 429 asks the
visitor to wait a minute before retrying. The previous
browser-only localStorage flag is ignored because it did not represent a saved
signup. A reload shows the form again; resubmitting confirms the existing row.

Before the launch, apply the checked-in migrations with `db:migrate:remote`,
then deploy the API and web Workers through the normal release process. This
change does not apply production migrations or deploy automatically. After
release, verify a fresh test address at `https://lanatools.sh`, query its row,
repeat the signup after a reload, and check invalid input and a failed request
followed by retry. Use browser network blocking for the failure check.

Inspect the list through the existing D1 account access:

```sh
bunx wrangler d1 execute DB --remote -c apps/api/wrangler.jsonc \
  --command 'SELECT email, created_at FROM early_access_signup ORDER BY created_at DESC LIMIT 50'
```

For local verification, use `--local` and `apps/api/wrangler.local.jsonc`.
The API tests use a throwaway D1 database; Playwright starts the local API
Worker and tests the browser against it. No list-reading HTTP route is exposed.
