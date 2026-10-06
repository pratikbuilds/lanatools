# LanaTools

Bun workspaces with a Hono API and React/Vite frontend using TanStack Router,
TanStack Query, and Tailwind. Shared HTTP schemas live in `packages/contracts`.

## Where things live

| Path                                    | What it owns                                                     |
| --------------------------------------- | ---------------------------------------------------------------- |
| `packages/toolkit`                      | The provider contract (`ToolProvider`) and its MCP adapter       |
| `packages/helius`, `jupiter`, `phoenix` | One provider each; usable in any project, no app imports         |
| `packages/catalog`                      | The pay.sh paid-API catalog and search                           |
| `packages/contracts`                    | Types shared by the API and web app                              |
| `apps/api/src/tools`                    | Which providers LanaTools serves (`providers.ts`) and `callTool` |
| `apps/api/src/mcp-grants.ts`            | Consent, grants and `authorizeGrant`, the one grant check        |
| `apps/api/src/solana/network.ts`        | Solana network table and server network configuration            |
| `apps/api/src/payments`                 | `call`: challenges, spending limits, signing and settlement      |
| `apps/mcp`                              | OAuth and the MCP server; provider tools run in the API          |
| `scripts/dev.ts`                        | Local devnet setup: `bun run dev`, `dev:reset` and `dev:fund`    |

## Development

Install Bun **1.4.2** and Node.js **24 LTS**. Node runs the Vite/ESLint toolchain;
Bun installs packages and runs unit tests. Wrangler runs the local Workers.

Local development runs on Solana devnet with a local database, so it never
touches production users, wallets or data.

1. Copy `.env.example` to `.env` and fill it in. Use a Privy app made for
   local development, never the production one, and create its payment signer
   once with `bun --env-file=.env apps/api/scripts/create-payment-signer.ts`.
2. Install and start:

   ```sh
   bun install --frozen-lockfile
   bun run dev
   ```

`bun run dev` checks `.env`, applies local migrations, builds the consent page
and starts three services:

| Service   | URL                         |
| --------- | --------------------------- |
| Dashboard | <http://localhost:5173>     |
| API       | <http://localhost:3000>     |
| MCP       | <http://localhost:8788/mcp> |

It reads secrets only from the root `.env`; per-app `.dev.vars` and
`.env.local` files are not used. It refuses to start with the production Privy
app, an RPC that does not serve devnet, Solana's public devnet RPC (Workers
cannot use it), a remote Cloudflare binding, or a busy port. If one service
stops, the others stop too. The dashboard proxies `/api` to the API.

Other commands:

- `bun run dev:reset` clears the local database and OAuth state, then applies
  migrations. Stop `bun run dev` first.
- `bun run dev:fund <wallet> <usdc>` sends devnet USDC from the default Solana
  CLI wallet, for example to the payment wallet the dashboard shows. It checks
  that the CLI's RPC is devnet first.

Paid calls go to the hosted devnet merchant,
`https://devnet-merchant-production.up.railway.app/api/v1/fixed` (0.01 USDC
over MPP and x402). The local testbed merchant cannot be used here, because
`pay_http` only calls public `https` URLs.

To check the setup end to end: run `bun run dev`, sign in at
<http://localhost:5173>, set up the payment wallet and fund it with
`dev:fund`, then connect Claude Code or Codex to `http://localhost:8788/mcp`,
approve a spending limit and ask it to pay the merchant URL above.

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
  `https://api.devnet.solana.com`; the testbed refuses to fund or pay unless
  its genesis hash is devnet's.

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

### Hosted devnet merchant

Deployed LanaTools cannot reach a merchant on your machine, so
`packages/testbed/Dockerfile` packages the same `merchant.yaml` as a devnet
container for Railway. It runs as the `devnet-merchant` service in the
`lanatools-testbed` Railway project at
`https://devnet-merchant-production.up.railway.app/api/v1/fixed`, unregistered
with pay.sh. The container refuses a non-devnet RPC and also serves
`/api/v1/policy-denied`.

To recreate it, give a Railway service a volume at `/data` and set
`RAILWAY_DOCKERFILE_PATH=Dockerfile`, `RECIPIENT` (the wallet that receives
payments), and optionally `DEVNET_RPC_URL`. Then run `railway up` from
`packages/testbed`.

On the first deploy pay creates the gateway's fee payer on the volume and
exits because it has no SOL; the deploy log shows its address. Send it about
0.1 devnet SOL (`solana transfer --url devnet <address> 0.1
--allow-unfunded-recipient`) and redeploy. The key stays on the volume, so
later deploys reuse it. The image pins pay 0.28.0: pay 0.29's gateway rejects
Pay Kit 0.12 MPP payments with "Challenge ID mismatch".

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

## Hosted app

The site, API, and MCP server run as Cloudflare Workers. `lanatools.sh`
serves the Vite build and forwards `/api/*` to `lanatools-api`, which is also
reachable at `api.lanatools.sh`. `mcp.lanatools.sh` serves MCP and its consent
page.

All three Workers connect to this repository through Cloudflare Workers
Builds and deploy production on pushes to `master`. Web and API also publish
Worker Previews for other branches. MCP builds only `master`; it has no
branch previews. See [MCP build settings](apps/mcp/README.md#automatic-deployment)
for its commands and required build variable.

The hosted app runs on Solana mainnet and pays real USDC; local development
and CI use devnet. Cloudflare calls the `master` environment "Production".
Set the web build variable `VITE_SOLANA_NETWORK=mainnet` to match the API's
`SOLANA_NETWORK=mainnet`.

Each Worker builds and deploys independently. GitHub's full `Check` workflow
runs separately and does not gate these deployments. API deployment applies
D1 migrations first. Changes between Workers must remain compatible during
rollout; this setup does not deploy all three atomically.

Preview URLs are public. A site Preview still calls the production API.
`/api/health` is a process-liveness check, not a database or external-dependency
readiness check. For a manual deployment:

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

## Component credits

The dashboard's animated counter (`apps/web/src/components/ui/animated-counter.tsx`)
is from [Rare UI](https://www.rareui.com), imported on October 2, 2026 from
<https://www.rareui.com/components/animatedcounter> and used under its license,
MIT with the Commons Clause and an attribution requirement.
