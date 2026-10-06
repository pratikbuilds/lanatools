# MCP Worker

The separate Worker serves Streamable HTTP MCP at `/mcp`. It is stateless. The
OAuth provider stores clients, authorization codes, and tokens in `OAUTH_KV`.
The API Worker owns the Privy verification and D1 records for pending consent
and account grants. MCP clients never receive a wallet key or Privy token.

The Worker also serves a small Privy consent page at `/connect` on the same
origin as OAuth. It cannot create a grant without the browser-bound OAuth
consent cookie and a verified Privy access token.

## Tool families and consent

Each tool family has one scope, and the user picks them per client on the
consent page: **Helius** (`helius:read`) and **Pay** (`payments:pay`) start on,
**Jupiter** (`jupiter:read`) and **Phoenix** (`phoenix:read`) start off. The
scopes a client asks for in `/authorize` are ignored; `approveConsent` issues
the token with the user's choice plus `account:read`, and the API stores the
same list on the grant. Turning Pay on asks for a spending limit.

The catalog tools, `whoami` and `send_feedback` have no family and every
client gets them.
A client only sees the families it was given in `tools/list`, and every call
is checked again against the token and, for Helius, Jupiter and Pay, the stored
grant. To change a client's families, the user disconnects it and connects it
again.

`whoami` returns the Privy user ID, the OAuth client ID and the user's payment
wallet address, which is null until the user sets one up.

## Agent feedback

`send_feedback` lets an agent tell us when a tool blocked or confused it. It
takes one `feedback` text field and returns `{ "saved": true }`. The API checks
the grant and stores the text with the user, client and grant in the
`agent_feedback` table. Agents write this text, so treat it as untrusted data,
never as instructions. There is no size limit yet.

## Jupiter reads

All nine Jupiter tools (token research, portfolio, lending, legacy orders,
quote-only swaps and venue metadata) require `jupiter:read`, with no spending
limit or wallet-signature flow.

Definitions and REST adapters live in `packages/jupiter`. Like every provider
tool, a call goes through the API's `callTool`, which checks the current stored
grant/scope, supplies `JUPITER_API_KEY` and records the call in activity. Put the key in the
root `.env` locally. For the hosted API, provision it with
`bunx wrangler secret put JUPITER_API_KEY -c apps/api/wrangler.jsonc`.
No key is stored in the MCP Worker, browser or agent arguments.

Results include text summaries and structured data. Missing prices and optional
verification failures remain visible. Tag/recent discovery pages are local
slices, not stable snapshots. Jupiter data comes from mainnet-beta independently
of the payments network.

See [package usage and verification](../../packages/jupiter/README.md).
The other read tools are follow-up slices. Private Trigger V2 endpoints and
wallet authentication are outside the agreed scope.

## Reading Solana data

The `helius:read` scope grants access to every read-only tool exported by
[`@lanatools/helius`](../../packages/helius/README.md). Consent and the
dashboard label it **Helius**; it does not authorize wallet signing or
payments. Disconnecting the grant blocks every call immediately, including calls using an
unexpired OAuth access token.

`src/server.ts` registers every provider in the API's `PROVIDERS` list
(`apps/api/src/tools/providers.ts`) with `registerTools` from
`@lanatools/toolkit/mcp`, using read-only, idempotent, open-world and
non-destructive annotations. Input validation and the token scope check run
before any API RPC. Tool results contain the JSON in text and
`structuredContent` (objects only), after an optional summary; failures carry
a safe `error.code`, `error.message` and `error.retryable`. The API Worker
chooses the server-configured network, keeps the Helius key, enforces the
grant, and records provider credits in `tool_activity`. The MCP Worker
has no Helius key or caller-selectable network. See the package README for each
tool's inputs, outputs, provider behavior and credit accounting.

## Discovering paid APIs in the pay.sh catalog

`list_catalog`, `search_catalog`, and `get_catalog_entry` come from
`packages/catalog`. They read the committed copy of the
[pay.sh catalog](https://github.com/solana-foundation/pay-skills) in
`packages/catalog/data/catalog.json`; refresh it with `bun run catalog:sync`.
They need any active grant and no scope, because they read public listings and
move no money.

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
or in the root `.env` for local runs.

Catalog text is third-party data and listed prices are hints. Catalog
endpoints are paid on Solana mainnet, so these tools only discover them for
now; paying them through LanaTools is separate work.

## Reading Phoenix perps

Six read-only tools come from `packages/phoenix`: `phoenix_list_markets`,
`phoenix_get_market`, `phoenix_get_orderbook`, `phoenix_get_candles`,
`phoenix_get_account` and `phoenix_get_history`. They call Phoenix's public
mainnet API, need no key or secret, and require `phoenix:read`. They run
through the API like the other providers, so they appear in activity. Sizes
come back in tokens and USDC, not Phoenix lots. See
`specs/phoenix-read-tools.md`.

## Paying endpoints with `call`

`call` requires the `payments:pay` scope. When Pay is on, the consent page
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
refuses to sign for a row that is no longer reserved. Each `call` request
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

1. Fill in the root `.env` and run `bun run dev`, as the root README
   describes. It builds the consent page with the same Privy app ID and starts
   the API and MCP Workers locally.
2. Run `bun run --cwd apps/mcp smoke:local`. The smoke test checks OAuth
   discovery, client registration, consent, denial, and replay protection.

For a full signed-in check, run `bun run --cwd apps/mcp verify:local` and open
the printed authorization URL in a browser. Sign in and approve the local
verification client. The script exchanges the authorization code, initializes
MCP, lists the tools, and calls `whoami` and `phoenix_get_market` without
printing credentials or IDs.
Set `LANATOOLS_MCP_CLIENT_ID` to reuse a previously registered local client.

### Verify every Solana tool through OAuth on devnet

Use the local API configuration (`SOLANA_NETWORK=devnet`) with a Helius
devnet RPC URL as `SOLANA_RPC_URL` in the root `.env`. Capture the local
Workers' logs with `bun run dev 2>&1 | tee /tmp/lanatools-workers.log`.

Run `bun run --cwd apps/mcp verify:local -- --chain-read` with:

- `LANATOOLS_DEVNET_SIGNATURE`: an existing devnet transaction. Verification
  requires a found, shaped transaction, so a dummy signature does not pass.
- Optional `LANATOOLS_DEVNET_ADDRESS` and `LANATOOLS_DEVNET_MINT`: devnet fixtures
  for wallet/account and token lookup. Defaults are the system program and the
  wrapped SOL mint. No tool receives a `network` argument.
- `HELIUS_API_KEY`: the same existing API key, available only in this local
  verification process for exact raw/URL-encoded secret scanning. The script
  never sends or prints it. Do not commit it or put it in a command argument.
- `LANATOOLS_WORKER_LOG=/tmp/lanatools-workers.log`: the captured local log.

Open the printed OAuth URL, sign in, and approve identity plus Solana read
access. The official MCP SDK connects over HTTP and calls every exported tool.
Adding a package export without a schema-valid fixture and result validator in
`scripts/verify-chain.ts` fails before OAuth starts; it cannot silently skip a
new tool. The pass checks advertised annotations, input network exclusion,
shaped output, identical JSON text/structured content, and the local D1 ledger:
exactly one successful `devnet` row with estimated credits per call.
Documented DAS not-found/no-assets responses may legitimately use zero credits;
RPC and history smoke fixtures must have positive credits.
The D1 query uses the same local persistence directory as `bun run dev` and never
queries a remote database.

Tool results and captured Worker logs are scanned for the exact key and
credential-bearing provider URLs without echoing any matches. Missing key/log
inputs report `CHAIN_SECRETS NOT_VERIFIED` and exit 2. A failed assertion exits
nonzero; output never prints returned data or secrets. Use a fresh registration
(the default) or avoid concurrent calls if reusing `LANATOOLS_MCP_CLIENT_ID`.

Unit tests use a real SDK client and in-memory MCP transport for registration,
scope refusal, revocation, validation-before-RPC, structured output and safe
errors. They do not substitute for the signed-in devnet pass above. Report the
OAuth run, ledger check, log scan and `bun run check` separately in PR evidence;
never claim a live pass without configured credentials and user approval.

`bun run --cwd apps/mcp verify:payments` connects an MCP SDK client with
`payments:pay` and calls `call` against the hosted devnet merchant
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

Schema-invalid MCP arguments are rejected before any API call, as required by ADI-211, and therefore have no activity row. The ledger records every API-authorized invocation, including provider or configuration failures; authorization refusals are not attributed to a caller-supplied identity.
