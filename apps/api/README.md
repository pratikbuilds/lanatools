# API

Hono on Bun for local development, and a Cloudflare Worker in production.
`src/app.ts` composes HTTP routes and middleware. `src/index.ts` validates
startup configuration and exports the Bun server. `src/worker.ts` is the
Worker entry deployed by `wrangler.jsonc`.

From the repository root, use `bun run dev` for both applications or
`bun run --cwd apps/api dev` for only the API. See the root README for tests
and production startup.
