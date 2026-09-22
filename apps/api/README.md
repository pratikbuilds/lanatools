# API

Hono on Bun. `src/app.ts` composes HTTP routes and middleware; `src/index.ts`
validates startup configuration and exports the Bun server configuration.

From the repository root, use `bun run dev` for both applications or
`bun run --cwd apps/api dev` for only the API. See the root README for tests,
production startup, and container commands.
