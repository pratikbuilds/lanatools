---
name: lanatools-connect
description: Connect this agent to LanaTools, one remote MCP server for Solana data, transactions and paid APIs. No account is needed to start. Use when asked to connect, install, add or set up LanaTools, or when a task needs Solana data, a Solana transfer, or a paid API.
---

# Connect to LanaTools

LanaTools is one remote MCP server. Add it and start working: no account,
login or API key is needed for Solana data or for transactions your own
wallet signs. The URL is the same for every client:

    https://mcp.lanatools.sh/mcp

Transport: Streamable HTTP.

## Add the server

Claude Code, in a terminal:

    claude mcp add --transport http lanatools https://mcp.lanatools.sh/mcp

Cursor, in `~/.cursor/mcp.json`:

    { "mcpServers": { "lanatools": { "url": "https://mcp.lanatools.sh/mcp" } } }

Codex, in `~/.codex/config.toml`:

    [mcp_servers.lanatools]
    url = "https://mcp.lanatools.sh/mcp"

Any other client: add a remote MCP server with that URL. Claude app and
claude.ai: Settings, Connectors, Add custom connector. ChatGPT: Settings,
Connectors, Create.

## What works without login

- Solana data: Helius account and transaction reads, Jupiter prices, tokens
  and quotes, Phoenix perps markets and accounts.
- The pay.sh catalog: `list_catalog`, `search_catalog`, `get_catalog_entry`.
- Transactions signed by a wallet you or the user control:
  `solana_transfer`, `solana_token_transfer`, `jupiter_swap` and the Phoenix
  trade tools, with
  - `delivery: "local"`: pass your `wallet`, sign the returned
    `transaction` yourself, then call `send_transaction`; or
  - `delivery: "link"`: share the returned `reviewUrl`; the user signs in
    their browser wallet.
- `get_transaction_status` and `whoami`. Without login, `whoami` returns
  `loggedIn: false`.

After a Phoenix trade confirms, give the user `accountUrl` from the result: a
public page of their Phoenix account that needs no login.

Without login you may make 30 tool calls a minute, one call per request.
Past that, a call returns an error saying to wait or log in.

## What needs login

- `delivery: "embedded"`: LanaTools signs with the user's LanaTools wallet.
- `call`: pays for an API from the user's LanaTools wallet, within the
  spending limit they set for you.
- `send_feedback`.

These tools say "Needs login" in their description. The first call to one
makes your client ask the user to log in. In Claude Code the user runs
`/mcp` and chooses Authenticate. Tell the user this step is coming; you
cannot log in on their behalf. Logging in opens LanaTools in their browser,
where they choose your tools and, for payments, your spending limit. Then
call the tool again.

## If you connect on your own

Connect as an MCP client over Streamable HTTP and send requests without a
token. A call that needs login is refused with 401 and points at the
resource metadata; follow the MCP authorization flow from there. The
authorization server is `https://mcp.lanatools.sh`, with `/register`,
`/authorize` and `/token`. PKCE must use S256.

1. Register once with dynamic client registration at `/register`. Use a
   `client_name` the user will recognise: it is shown on the approval screen
   and in their dashboard. Keep the `client_id`.
2. Send the user to `/authorize` with PKCE, your `redirect_uri`, and the
   scopes the task needs.
3. Exchange the code at `/token`. Keep the tokens, refresh them when they
   expire, and send the access token on every request.

## Scopes, after login

- `account:read` is on every grant and lets you call `whoami`.
- `helius:read`, `jupiter:read`, `phoenix:read` read Solana data.
- `solana:transfer` permits SOL and token transfers.
- `phoenix:trade` permits Phoenix activation, collateral and trades on mainnet. Local activation also needs the base58 signature of `messageToSign` as `messageSignature`. Phoenix supplies its co-signature and submits. Retry accepted Phoenix requests only to check status; reconcile unknown results before creating another request.
- `payments:pay` calls paid endpoints from the user's wallet, within the
  spending limit they set for you.

The user chooses the scopes on the approval screen; what you ask for is a
suggestion. Ask only for what the task needs.

## Rules

- Never ask the user for a private key or seed phrase. LanaTools never needs
  one. With `delivery: "local"`, sign with a wallet you already control.
- Before retrying a transaction, check `get_transaction_status`. The same
  `idempotencyKey` returns the same transaction, except for a link made
  without login, which is new each time.
- If a paid call fails or its outcome is unclear, do not call it again
  before checking what happened to the first one. The user's dashboard
  shows every call and charge.
- If a logged-in call is refused as unauthorized, the user may have
  disconnected you. Ask them to connect you again instead of retrying.
