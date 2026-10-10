---
name: lanatools-connect
description: Connect this agent to LanaTools, one remote MCP server for Solana data and paid APIs. Use when asked to connect, install, add or set up LanaTools, or when a task needs Solana data or a paid API that the user pays for from their LanaTools wallet.
---

# Connect to LanaTools

LanaTools is one remote MCP server. The user connects you once, approves
what you may use, and sets how much you may spend. The URL is the same for
every client:

    https://mcp.lanatools.sh/mcp

Transport: Streamable HTTP. Sign-in: OAuth 2.1 with PKCE (S256; plain PKCE
is refused). There is no API key, and you never need one.

## If you run inside an MCP client

Add the server to the client, then let the client sign in.

Claude Code, in a terminal:

    claude mcp add --transport http lanatools https://mcp.lanatools.sh/mcp

Cursor, in `~/.cursor/mcp.json`:

    { "mcpServers": { "lanatools": { "url": "https://mcp.lanatools.sh/mcp" } } }

Codex, in `~/.codex/config.toml`:

    [mcp_servers.lanatools]
    url = "https://mcp.lanatools.sh/mcp"

Any other client: add a remote MCP server with that URL and OAuth. Claude
app and claude.ai: Settings, Connectors, Add custom connector. ChatGPT:
Settings, Connectors, Create, with OAuth.

## If you connect on your own

Connect as an MCP client over Streamable HTTP. The first request is refused
with 401 and points at the resource metadata; follow the MCP authorization
flow from there. The authorization server is `https://mcp.lanatools.sh`,
with `/register`, `/authorize` and `/token`.

1. Register once with dynamic client registration at `/register`. Use a
   `client_name` the user will recognise: it is shown on the approval screen
   and in their dashboard. Keep the `client_id`.
2. Send the user to `/authorize` with PKCE, your `redirect_uri`, and the
   scopes the task needs.
3. Exchange the code at `/token`. Keep the tokens and refresh them when they
   expire.

## Scopes

- `account:read` is on every grant and lets you call `whoami`.
- `helius:read`, `jupiter:read`, `phoenix:read` read Solana data.
- `payments:pay` calls paid endpoints from the user's wallet, within the
  spending limit they set for you.

The user chooses the scopes on the approval screen; what you ask for is a
suggestion. Ask only for what the task needs.

## What the user does

Approving opens LanaTools in the user's browser. They sign in, choose your
tools, and, if payments are on, set your spending limit in USD. The
connection is then live. Tell the user this step is coming; you cannot
approve on their behalf.

## Check that it worked

Call `whoami`. It returns only the user's payment wallet address, which is
null until they set a wallet up. Then
`list_catalog` or `search_catalog` finds paid endpoints, and `call` pays
for one within your limit.

## Rules

- Never ask the user for a private key, seed phrase or wallet. LanaTools
  never needs one.
- If a paid call fails or its outcome is unclear, do not call it again
  before checking what happened to the first one. The user's dashboard
  shows every call and charge.
- If a call is refused as unauthorized, the user may have disconnected you.
  Ask them to connect you again instead of retrying.
