# MCP Worker

The separate Worker serves Streamable HTTP MCP at `/mcp`. It is stateless. The
OAuth provider stores clients, authorization codes, and tokens in `OAUTH_KV`.
The API Worker owns the Privy verification and D1 records for pending consent
and account grants. MCP clients never receive a wallet key or Privy token.

The first tool, `whoami`, requires an `account:read` OAuth token and an active
grant. It returns the Privy user ID and OAuth client ID. It cannot make payments.

## Local run

1. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in ignored
   `apps/api/.dev.vars`. Put `VITE_PRIVY_APP_ID` and
   `VITE_MCP_ORIGIN=http://localhost:8788` in ignored
   `apps/web/.env.local`.
2. Run `bun run --cwd apps/api db:migrate:local`.
3. Run `bun run dev:mcp` and `bun run --cwd apps/web dev` in separate terminals.
4. Run `bun run --cwd apps/mcp smoke:local`. The smoke test checks OAuth
   discovery, client registration, consent, denial, and replay protection.

Use `http://localhost:8788/mcp` as the MCP server URL. An MCP client redirects
the user to the web consent page, which uses their normal Privy sign-in. The
browser returns to the client's registered callback after approval or denial.

Hosted deployment needs a KV namespace for OAuth, the hosted API D1 binding,
Privy credentials on the API Worker, and the `mcp.lanatools.sh` route. Local
verification does not provision or deploy these resources.
