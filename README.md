# LanaTools

Bun workspaces with a Hono API and React/Vite frontend using TanStack Router,
TanStack Query, and Tailwind. Shared HTTP schemas live in `packages/contracts`.

## Development

Install Bun **1.4.2** and Node.js **24 LTS**. Node runs the Vite/ESLint toolchain;
Bun installs packages and runs the API and unit tests.

```sh
bun install --frozen-lockfile
bun run dev
```

Open <http://localhost:5173>. The API listens on port 3000; the frontend proxies
`/api` requests to it. The home page reports the real API connection status.
The default configuration works without an environment file. To change the API
port, copy `apps/api/.env.example` to `apps/api/.env`, edit `PORT`, and set
`API_PROXY_TARGET=http://127.0.0.1:<port>` when starting the frontend.
Only the Vite server reads `API_PROXY_TARGET`; it is never bundled into the browser.

## Checks

```sh
bunx playwright install chromium
bun run check
```

The gate runs formatting, lint, type checks, production builds, Bun unit tests,
and a Chromium test against the built frontend and backend. The browser test
stops its own API, checks the failure state, restarts it, and retries. A second
test verifies that an offline query cannot report a successful connection. Ports
3101 and 4173 must be free. Existing servers are never intentionally reused.

Individual commands: `bun run format`, `bun run lint`, `bun run typecheck`,
`bun run build`, `bun run test`, and `bun run test:e2e`. Build before running
`test:e2e` directly. Generated routing is refreshed before type checking.

## Production

The site and API run as Cloudflare Workers. `lanatools.sh` serves the Vite
build and forwards `/api/*` to the `lanatools-api` Worker, which is also
reachable at `api.lanatools.sh`. Pushes to `master` deploy both through
Workers Builds. `/api/health` is a process-liveness check, not a database or
external-dependency readiness check.

```sh
bun run deploy
```

`apps/api/src/index.ts` remains the local Bun server. Its default port is 3000.
Override `PORT` with an integer from 1 to 65535.

```sh
bun run build
bun run --cwd apps/api start
```

Build the API container from the repository root:

```sh
docker build -f apps/api/Dockerfile -t lanatools-api .
docker run --rm -p 3000:3000 lanatools-api
```

Vite's development/preview proxy is not a production reverse proxy.

Database, authentication, and product-specific routes are not scaffolded yet.

## Template provenance

Generated on September 22, 2026 using `create-hono@0.19.5` with the Bun template
and `@tanstack/cli@0.71.0` with React, `--router-only`, ESLint, and no examples.
The import commit preserves the starter code, with generated formatting applied.
Integration adapts the generated routes, middleware, and workspace configuration.
MIT notices are retained in `licenses/`.

- <https://github.com/honojs/starter>
- <https://github.com/TanStack/cli>

Interchange informed the backend organization; no Interchange source was copied.
