# Manual acceptance: local MCP OAuth

This checklist covers the MCP server in this PR. Its only tool is `whoami` and
its only scope is `account:read`. Complete the cases in order. Keep the MCP
server running while testing; each `verify:local` run waits at most 10 minutes
for its browser callback.

## Start the local server

From the repository root, make sure ignored `apps/api/.dev.vars` has
`PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and ignored
`apps/mcp/consent/.env.local` has the same public ID as `VITE_PRIVY_APP_ID`.
Then use two terminal windows:

```sh
bun run --cwd apps/api db:migrate:local
bun run dev:mcp
```

Leave that terminal open. It should report `Ready on http://localhost:8788`.
In the other terminal, run:

```sh
bun run --cwd apps/mcp smoke:local
```

Expected: `MCP OAuth discovery, registration, browser-bound consent, denial,
and replay checks passed`. This also checks that an unsigned approval and a
cross-origin consent POST are rejected.

## Browser cases

| Case                   | What to do                                                                                                                                         | Expected result                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No request             | Open `http://localhost:8788/connect` directly.                                                                                                     | The page says to open it from an MCP client. There is no Connect button for an unknown request.                                                                                                                                                                             |
| Consent details        | Run `bun run --cwd apps/mcp verify:local` in the second terminal. Open its `OPEN_AUTH_URL` in a browser within 10 minutes.                         | You land on `http://localhost:8788/connect?...`. It names **LanaTools local verification**, says it can read your account identity, shows callback `127.0.0.1:8932`, identifies the client name as unverified, and says it cannot sign or pay.                              |
| Sign in and switch     | On that page, sign in with Google or a Solana wallet. Check the displayed account. Select **Sign out to use another account**, then sign in again. | The page shows the account currently signed in through Privy. Signing out returns to the sign-in choice while keeping this pending request. Use a second account if you have one; the displayed account should change.                                                      |
| Deny                   | With a fresh `verify:local` request open, choose **Deny**.                                                                                         | The browser reaches `127.0.0.1:8932/callback` and says authorization returned. The verifier exits with an `access_denied` assertion because it expects approval; **this failure is expected for this case**. Reloading the old `/connect?...` URL says the request expired. |
| Approve and call       | Run `verify:local` again, open its new `OPEN_AUTH_URL`, sign in, and choose **Connect**.                                                           | The browser reaches the local callback. The terminal prints `TOKEN_EXCHANGE passed`, `MCP_INITIALIZE passed`, `MCP_TOOLS_LIST passed`, and `MCP_WHOAMI passed`, then exits successfully. No wallet action or payment prompt appears.                                        |
| Single use             | Reload the `/connect?...` URL from the successful approval.                                                                                        | The request is expired and cannot be approved a second time.                                                                                                                                                                                                                |
| Unsupported permission | Start another `verify:local` run. Open a copy of its `OPEN_AUTH_URL` with only `scope=account%3Aread` changed to `scope=wallet%3Apay`.             | The server responds `Unsupported access request` with HTTP 400. No payment permission is offered. Stop this verifier with Ctrl-C, or complete its original unchanged URL.                                                                                                   |

Each `verify:local` run registers a new client unless
`LANATOOLS_MCP_CLIENT_ID` is set. Run it twice and compare the `client_id`
parameters in the printed URLs if you want to confirm that two clients get
separate OAuth identities. Do not share these authorization URLs publicly.

## Real Codex client

The verifier above proves the protocol with a local client. To check Codex
itself, keep `bun run dev:mcp` running and use another terminal:

```sh
codex mcp add lanatools-local --url http://localhost:8788/mcp
codex mcp login lanatools-local --oauth-client-registration dcr --scopes account:read
```

If `add` opens the authorization page already, complete that flow and skip the
separate `login`. The browser should show the same MCP-origin consent page.
Approve it, then start a new Codex chat with `lanatools-local` enabled and ask
it to call `whoami`. Expected: the tool returns the Privy user ID and this
Codex client's ID. The available tool list contains `whoami`; there is no
payment or transaction tool. To clean up the local Codex connection later:

```sh
codex mcp logout lanatools-local
codex mcp remove lanatools-local
```

Browser sign-out changes the Privy browser session; it does not revoke an
already approved MCP client.

## Not testable in this PR

Wallet-bound grants, payment calls, per-client spending limits, credits,
transaction tools, activity, revocation controls, and hosted MCP deployment
are not implemented. The existing Pay Kit testbed and wallet dashboard are
separate work and do not make this MCP connection able to spend.
