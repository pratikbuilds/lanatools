# MCP Worker

The separate Worker serves Streamable HTTP MCP at `/mcp`. It is stateless. The
OAuth provider stores clients, authorization codes, and tokens in `OAUTH_KV`.
The API Worker owns the Privy verification and D1 records for pending consent
and account grants. MCP clients never receive a wallet key or Privy token.

The Worker also serves a small Privy consent page at `/connect` on the same
origin as OAuth. The page shows the requested access and the registered
callback host. It cannot create a grant without the browser-bound OAuth consent
cookie and a verified Privy access token.

`whoami` requires an `account:read` token and an active grant and returns
the Privy user ID and OAuth client ID.

## Discovering paid APIs in the pay.sh catalog

`list_catalog`, `search_catalog`, and `get_catalog_entry` come from
`packages/catalog`. They read the committed copy of the
[pay.sh catalog](https://github.com/solana-foundation/pay-skills) in
`packages/catalog/data/catalog.json`; refresh it with `bun run catalog:sync`.
They need any active grant and no extra scope, because they read public
listings and move no money.

- `list_catalog` groups every provider by category.
- `search_catalog` ranks providers and endpoints for a task with TypeSafe's
  Jev model when the `TYPESAFE_API_KEY` secret is set, and with pay's keyword
  scorer otherwise or whenever TypeSafe fails. An empty result means nothing
  in the catalog does the task. See `specs/catalog-search-jev.md`.
- `get_catalog_entry` returns a provider's endpoints and usage notes. With an
  endpoint `path`, it also fetches that provider's OpenAPI document live and
  returns the endpoint's parameters, request body, and only the components
  they reference.

Set the key with `wrangler secret put TYPESAFE_API_KEY -c apps/mcp/wrangler.jsonc`,
or in `apps/mcp/.dev.vars` for local runs.

Catalog text is third-party data and listed prices are hints. Catalog
endpoints are paid on Solana mainnet, so these tools only discover them for
now; paying them through LanaTools is separate work.

## Reading Phoenix perps

Six read-only tools come from `packages/phoenix`: `phoenix_list_markets`,
`phoenix_get_market`, `phoenix_get_orderbook`, `phoenix_get_candles`,
`phoenix_get_account` and `phoenix_get_history`. They call Phoenix's public
mainnet API, need no key or secret, and need any active grant and no extra
scope. Sizes come back in tokens and USDC, not Phoenix lots. See
`specs/phoenix-read-tools.md`.

## Paying endpoints with `pay_http`

`pay_http` requires the `payments:pay` scope. The consent page shows it and
asks the user for a USD spending limit for that client; the limit is stored on
the grant and can be edited in the dashboard. The caller names an https
endpoint and a `max_usd`. The API Worker (`apps/api/src/payments/`) then:

1. Fetches the endpoint once. Anything but HTTP 402 is returned unpaid.
2. Accepts only a fixed charge (MPP `charge`, x402 `exact`) on
   `SOLANA_NETWORK`, in that network's USDC, within `max_usd`.
3. Reserves the amount in one D1 statement that also checks the grant is
   active with `payments:pay`, the user's server signer is enabled, and the
   client's limit has room. Concurrent calls cannot overspend.
4. Pays through Pay Kit with the user's Privy wallet, limited to the network,
   the endpoint's origin and the charged amount. If Pay Kit's own read of the
   challenge differs from the reserved one, it stops before signing.
5. Waits for the transaction to finalize and checks it moved exactly the
   charge from the wallet to the recipient, then records it as spent.

Only a refusal proven to precede signing (a Pay Kit `PermissionDeniedError`,
a changed charge, or a Privy `policy_violation`) releases the reservation. Any
other failure keeps it held as `uncertain`, and the tool never repeats a paid
request.

The signer records the wallet's signature and the transaction's blockhash on
the activity row before the signed transaction can leave the Worker, and
refuses to sign for a row that is no longer reserved. Each `pay_http` call
first resolves the client's reservations older than five minutes, so a call
cut off midway does not hold the limit forever: a row with no recorded
transaction is released; a signed row stays held while its blockhash is
valid, then is settled if the wallet's history shows it finalized, or
released if it never landed or failed.

Every call gets a `payment_activity` row with no request or response
body. Spent and reserved amounts are summed per user and client, so they
survive a reconnect.

Endpoints are untrusted: only https on the default port, no credentials in the
URL, no loopback, private or link-local hosts, an allowlist of request
headers, redirects returned rather than followed, and timeouts. Responses are
returned whole: as text when they are UTF-8, otherwise base64
(`bodyEncoding`). The agent's LanaTools token never reaches the endpoint.

### Server signer

The dashboard's **Agent payments** switch adds the LanaTools key quorum to the
user's embedded wallet through Privy's `addSigners`, with a user-owned override
policy that allows only USDC `TransferChecked` plus Compute Budget and Memo
instructions. The policy sets no amount; each client's limit in D1 bounds what
it can spend. The API enables payments only after Privy
reports that signer and policy on the wallet. Turning it off disables payments
in D1 first, then removes the wallet's signers.

The API signs through an in-repo Kit signer over `@privy-io/node`
(`privy-signer.ts`). `@solana/keychain-privy` cannot run on Workers: its HTTP
helper passes `redirect: 'error'` to `fetch`, which Workers rejects.

## Connected apps and revocation

Approving a client copies its self-reported name and the approved redirect URI
onto the user's grant, so a later unapproved request cannot change how an
existing connection is shown. The web dashboard lists a user's active grants at
`GET /api/mcp/clients` and disconnects one with
`POST /api/mcp/clients/:grantId/revoke`, both authenticated with a Privy access
token.

Revocation has two layers. D1 is the source of truth: the grant becomes
`revoked`, every tool call goes through one grant check, and
`tokenExchangeCallback` refuses to refresh a revoked grant. The API then calls
`McpTokenService.revokeClient` on this Worker, which deletes the matching OAuth
grants and tokens from `OAUTH_KV`. If that call fails, the next tool call or
refresh from the client deletes them. Reconnecting a revoked client creates a
new grant ID, so tokens issued before the revocation never work again.

## Local run

1. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in ignored
   `apps/api/.dev.vars`. For payments, run
   `bun --env-file=.env apps/api/scripts/create-payment-signer.ts` once and add
   its `PRIVY_PAYMENT_SIGNER_ID` and `PRIVY_PAYMENT_SIGNER_KEY`, plus a devnet
   `SOLANA_RPC_URL` from an RPC provider. The public
   `api.devnet.solana.com` answers Workers with HTTP 403. Put the same public app ID as `VITE_PRIVY_APP_ID` in
   ignored `apps/mcp/consent/.env.local`.
2. Run `bun run --cwd apps/api db:migrate:local`.
3. Run `bun run dev:mcp`. This builds the consent page and starts the API and
   MCP Workers locally.
4. Run `bun run --cwd apps/mcp smoke:local`. The smoke test checks OAuth
   discovery, client registration, consent, denial, and replay protection.

For a full signed-in check, run `bun run --cwd apps/mcp verify:local` and open
the printed authorization URL in a browser. Sign in and approve the local
verification client. The script exchanges the authorization code, initializes
MCP, lists the tools, and calls `whoami` and `phoenix_get_market` without
printing credentials or IDs.
Set `LANATOOLS_MCP_CLIENT_ID` to reuse a previously registered local client.

`bun run --cwd apps/mcp verify:payments` connects an MCP SDK client with
`payments:pay` and calls `pay_http` against the hosted devnet merchant
(`https://devnet-merchant-production.up.railway.app/api/v1`): refusals first,
then MPP and x402 on `/fixed` and the Privy denial on `/policy-denied`. Fund
the wallet with devnet USDC first. Pass `refusals` to skip spending, and set
`LANATOOLS_MCP_ORIGIN` if the Worker is not on port 8788. The Privy app must
allow the consent and dashboard origins (`http://localhost:8788`,
`http://localhost:5173`), or Privy's iframe refuses to load.

Use `http://localhost:8788/mcp` as the MCP server URL. An MCP client redirects
the user to `http://localhost:8788/connect`. Privy sign-in happens on that
origin, and the browser returns to the client's registered callback after
approval or denial. The regular web app may use a separate browser session.

## Hosted run

The hosted endpoint is `https://mcp.lanatools.sh/mcp`. The MCP Worker uses its
own OAuth KV namespace and calls the production API Worker, which stores grants
in `lanatools-production` D1. Set `PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
`PRIVY_PAYMENT_SIGNER_ID`, `PRIVY_PAYMENT_SIGNER_KEY` and `SOLANA_RPC_URL` as
API Worker secrets, supply `VITE_PRIVY_APP_ID` when building consent assets, and
allow `https://mcp.lanatools.sh` in the Privy app's domains. The API and MCP
Workers bind to each other.

### Automatic deployment

The `lanatools-mcp` Worker is connected to `pratikbuilds/lanatools` through
Cloudflare Workers Builds. These settings live in Cloudflare under
**Settings → Builds**, not in Wrangler or a GitHub deployment workflow:

| Setting                            | Value                                                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| Production branch                  | `master`                                                          |
| Root directory                     | `/`                                                               |
| Build command                      | `bun test apps/mcp/src && bun run --cwd apps/mcp build`           |
| Deploy command                     | `bunx wrangler deploy -c apps/mcp/wrangler.jsonc`                 |
| Builds for non-production branches | Disabled                                                          |
| Build watch paths                  | Include `*`; no exclusions                                        |
| Build variable                     | `VITE_PRIVY_APP_ID`, the same public app ID used by the web build |
| API token                          | Reuse the existing Workers Builds token used by web/API           |

A push or merge to `master` tests MCP, builds the consent page, and deploys
`mcp.lanatools.sh`. Failed MCP tests or builds stop that deployment. The full
GitHub `Check` workflow runs independently; Cloudflare does not wait for it.
Web, API, and MCP also deploy independently, so cross-Worker changes must
remain compatible while their deployments finish.

MCP branch previews are disabled. Its OAuth KV and API service binding are
production resources; do not enable preview authorization tests against them.
Merging documentation changes does not configure Workers Builds: the repository
connection, branch control, commands, token, and build variable must also be
saved in Cloudflare. Follow the
[Workers Builds configuration guide](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
when recreating the setup.

### Manual recovery

For a manual rollout, apply new D1 migrations with
`bun run --cwd apps/api db:migrate:remote`, then run `bun run deploy:mcp`
followed by `bun run deploy:api`. Normal API builds already apply migrations
before deployment. Supply `VITE_PRIVY_APP_ID` when building MCP locally.
