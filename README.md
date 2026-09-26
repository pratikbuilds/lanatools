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

## Payment testbed

Pays a fixed 0.01 USDC charge on the hosted Surfpool sandbox that `pay
--sandbox` uses, so no real funds move. Needs the [pay CLI](https://pay.sh) on
`PATH` and port 1402 free.

```sh
bun run testbed check   # start, pay once, verify on chain, stop
bun run testbed start   # keep the merchant running
bun run testbed pay     # pay it while `start` runs
```

`start` serves `packages/testbed/merchant.yaml` with `pay --sandbox gate api`.
`check` expects a localnet USDC challenge for 10000 base units, pays it with
`pay --sandbox curl`, and confirms on `https://402.surfnet.dev:8899` that the
merchant's USDC balance rose by that amount.

`start` and `check` reset `packages/testbed/.state`, so pay creates new
auto-funded wallets there; `pay` reuses them. pay gets only `PATH` and a `HOME`
in that directory, so it never sees your shell credentials or `~/.config/pay`.

### Privy signing proof

With a dedicated Privy development app, put `PRIVY_APP_ID` and
`PRIVY_APP_SECRET` in an ignored `.env` file. Start a local validator with
`surfpool start --offline --no-tui --no-studio --no-deploy`, then run
`bun --env-file=.env run testbed:privy`. This creates a fresh user-owned Privy
test wallet and server signer on each run, signs a small transfer, submits it
to Surfpool, verifies its result, and checks a policy denial. See the
[ADI-175 proof](specs/adi-175-privy-surfpool.md) for the recorded result and
limits.

## Production

The site and API run as Cloudflare Workers. `lanatools.sh` serves the Vite
build and forwards `/api/*` to the `lanatools-api` Worker, which is also
reachable at `api.lanatools.sh`. Pushes to `master` deploy both through
Workers Builds. Pushes to any other branch publish a Worker Preview for each
app and do not change `lanatools.sh`. Preview URLs are public. A site Preview
still calls the production API. `/api/health` is a process-liveness check, not
a database or external-dependency readiness check.

```sh
bun run deploy
```

`apps/api/src/index.ts` remains the local Bun server. Its default port is 3000.
Override `PORT` with an integer from 1 to 65535.

```sh
bun run build
bun run --cwd apps/api start
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
