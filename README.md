# LanaTools

Bun workspaces with a Hono API and React/Vite frontend using TanStack Router,
TanStack Query, and Tailwind. Shared HTTP schemas live in `packages/contracts`.

## Development

Install Bun **1.4.2** and Node.js **24 LTS**. Node runs the Vite/ESLint toolchain;
Bun installs packages and runs unit tests. Wrangler runs the local API.

```sh
bun install --frozen-lockfile
bun run --cwd apps/api db:migrate:local
bun run dev
```

Open <http://localhost:5173>. The local Worker listens on port 3000; the
frontend proxies `/api` requests to it. The home page reports the real API
connection status. To change the Worker port, pass `--port` to Wrangler and set
`API_PROXY_TARGET=http://127.0.0.1:<port>` when starting the frontend.
Only the Vite server reads `API_PROXY_TARGET`; it is never bundled into the browser.

## Checks

```sh
bunx playwright install chromium
bun run check
```

The gate runs formatting, lint, type checks, production builds, Bun unit tests,
a local Worker/D1 write-read smoke check, and a Chromium test against the built
frontend and backend. The browser test
stops its own API, checks the failure state, restarts it, and retries. A second
test verifies that an offline query cannot report a successful connection. Ports
3101, 3102, and 4173 must be free. Existing servers are never intentionally reused.

Individual commands: `bun run format`, `bun run lint`, `bun run typecheck`,
`bun run build`, `bun run test`, and `bun run test:e2e`. Build before running
`test:e2e` directly. Generated routing is refreshed before type checking.

## Payment testbed

Runs a private pay.sh merchant, `packages/testbed/merchant.yaml`, that charges
a fixed 0.01 USDC over MPP and x402. Needs the [pay CLI](https://pay.sh) on
`PATH` and port 1402 free. Choose a network with `--network`:

- **sandbox** (default): the hosted Surfpool that `pay --sandbox` uses. Wallets
  are funded with cheatcodes and no real funds move.
- **devnet**: Solana devnet with Circle's devnet USDC. The default Solana CLI
  keypair (`solana address`) needs devnet SOL and USDC. It receives merchant
  payments, funds test wallets, and gives the gateway's fee payer 0.1 SOL the
  first time it starts. Set `DEVNET_RPC_URL` to use an RPC other than
  `https://api.devnet.solana.com`.

```sh
bun run testbed check           # sandbox: start, pay over MPP and x402, verify, stop
bun run testbed start           # keep the sandbox merchant running
bun run testbed pay             # pay it with pay curl while `start` runs
bun run testbed:devnet check    # the same check on devnet
bun run testbed:devnet start    # keep the devnet merchant running
```

`start` writes the spec with the chosen network into
`packages/testbed/.state/<network>/` and serves it with `pay gate api`.
`check` expects a USDC challenge for 10000 base units on that network, pays it
over each protocol with Pay Kit from a new funded keypair, and confirms that
the merchant's USDC balance rose by that amount. `pay` is sandbox-only because
pay 0.28 refuses devnet challenges with a false insufficient-balance error.

The sandbox state is reset on every start, so pay creates new auto-funded
wallets; `pay` reuses them. The devnet state persists so the funded fee payer
survives restarts. pay gets only `PATH` and a `HOME` in the state directory, so
it never sees your shell credentials or `~/.config/pay`.

### Privy signing proof

With a dedicated Privy development app, put `PRIVY_APP_ID` and
`PRIVY_APP_SECRET` in an ignored root `.env` file. Set the public app ID as
`VITE_PRIVY_APP_ID` in `apps/proof/.env.local`. Run `bun run proof`,
open `http://localhost:5174`, sign in, and copy the token into
the root `.env` as `PRIVY_USER_ACCESS_TOKEN`. Keep the token out of chat and
source control. Start `surfpool start --offline --no-tui --no-studio --no-deploy`,
then run `bun --env-file=.env run testbed:privy` before the token expires.
The script creates a wallet and policy owned by that authenticated Privy user,
signs a small transfer, submits it to Surfpool, checks policy denials, and
tests user-authorized edits. It archives or deletes the remote test resources
on exit where Privy permits. It also rejects multi-transfer transactions
locally because Privy's limit applies to each instruction. See the
[ADI-175 proof](specs/adi-175-privy-surfpool.md) for the recorded result and
limits.

### Pay Kit payment proof

`apps/proof` holds local-only proof pages, kept apart from the product UI in
`apps/web`. With the same `.env` files, run `bun run testbed start` to serve
`packages/testbed/merchant.yaml`, then `bun --env-file=.env run testbed:paykit`
and `bun run proof`. For devnet, use `bun run testbed:devnet start` and
`bun --env-file=.env run testbed:paykit:devnet`; each new proof wallet receives
0.10 devnet USDC from the Solana CLI keypair. Sign in at `http://localhost:5174` and use the MPP,
x402, Pay Kit denial, and Privy policy denial buttons. The page sends your
Privy access token only to the local proof server; you never paste it. Pay Kit
pays the existing YAML merchant on the chosen network from a Privy
wallet you own, using the official Solana Privy signer. Its user-owned policy
allows bounded USDC transfers without naming a merchant. The local proof
reserves each payment against a 0.10 USDC wallet budget before calling Pay
Kit. Restart the YAML merchant after editing its spec. The page offers fixed
MPP and x402 payment checks. Ctrl-C on the proof server archives wallets and
attempts to delete policies and the key quorum.

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

`apps/api/src/index.ts` remains a Bun server for the health test and manual startup.
Its default port is 3000. Override `PORT` with an integer from 1 to 65535.

```sh
bun run build
bun run --cwd apps/api start
```

Vite's development/preview proxy is not a production reverse proxy.

The local Worker has D1 and a smoke table. Authentication and product-specific
tables and routes are not scaffolded yet.

## Template provenance

Generated on September 22, 2026 using `create-hono@0.19.5` with the Bun template
and `@tanstack/cli@0.71.0` with React, `--router-only`, ESLint, and no examples.
The import commit preserves the starter code, with generated formatting applied.
Integration adapts the generated routes, middleware, and workspace configuration.
MIT notices are retained in `licenses/`.

- <https://github.com/honojs/starter>
- <https://github.com/TanStack/cli>

Interchange informed the backend organization; no Interchange source was copied.
