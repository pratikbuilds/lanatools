# MCP Worker

The separate Worker serves Streamable HTTP MCP at `/mcp`. It is stateless. The
OAuth provider stores clients, authorization codes, and tokens in `OAUTH_KV`.
The API Worker owns the Privy verification and D1 records for pending consent
and account grants. MCP clients never receive a wallet key or Privy token.

The Worker also serves a small Privy consent page at `/connect` on the same
origin as OAuth. The page shows the requested access and the registered
callback host. It cannot create a grant without the browser-bound OAuth consent
cookie and a verified Privy access token.

The first tool, `whoami`, requires an `account:read` OAuth token and an active
grant. It returns the Privy user ID and OAuth client ID. This grant has no
wallet, payment limit, or signing authority. The product's payment flow needs
the wallet-bound grant, per-client cumulative limit, atomic reservation, and
signer separation described in `specs/agent-payments.md` and
`docs/privy-wallet-access.md` before any spending tool is exposed. No Durable
Object is part of this OAuth slice.

## Connected apps and revocation

Consent records the client's self-reported name and redirect URI in the
`mcp_client` D1 table. The web dashboard lists a user's active grants at
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
   `apps/api/.dev.vars`. Put the same public app ID as `VITE_PRIVY_APP_ID` in
   ignored `apps/mcp/consent/.env.local`.
2. Run `bun run --cwd apps/api db:migrate:local`.
3. Run `bun run dev:mcp`. This builds the consent page and starts the API and
   MCP Workers locally.
4. Run `bun run --cwd apps/mcp smoke:local`. The smoke test checks OAuth
   discovery, client registration, consent, denial, and replay protection.

For a full signed-in check, run `bun run --cwd apps/mcp verify:local` and open
the printed authorization URL in a browser. Sign in and approve the local
verification client. The script exchanges the authorization code, initializes
MCP, lists the tools, and calls `whoami` without printing credentials or IDs.
Set `LANATOOLS_MCP_CLIENT_ID` to reuse a previously registered local client.

Use `http://localhost:8788/mcp` as the MCP server URL. An MCP client redirects
the user to `http://localhost:8788/connect`. Privy sign-in happens on that
origin, and the browser returns to the client's registered callback after
approval or denial. The regular web app may use a separate browser session.

## Hosted run

The hosted endpoint is `https://mcp.lanatools.sh/mcp`. The MCP Worker uses its
own OAuth KV namespace and calls the production API Worker, which stores grants
in `lanatools-production` D1. Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` as API
Worker secrets, supply `VITE_PRIVY_APP_ID` when building consent assets, and
allow `https://mcp.lanatools.sh` in the Privy app's domains. The API and MCP
Workers bind to each other. Apply new D1 migrations with
`bun run --cwd apps/api db:migrate:remote`, then run `bun run deploy:mcp`
followed by `bun run deploy:api`.
Do not point a preview Worker at production KV or D1 for authorization tests.
