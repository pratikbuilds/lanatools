# Product

<!-- impeccable:product-schema 1 -->

Derived from `product.md` (working draft). Facts below are the draft's; nothing here is confirmed beyond it.

## Platform

web

## Users

Solana power users who already ask AI agents (Cursor, Claude, a cloud agent) to carry out tasks. They want an agent to fetch chain and market data, call a paid service, or prepare a transaction without setting up a separate MCP server and wallet flow for each task. Their first use is a paid endpoint they can call without hours of local setup.

## Product Purpose

One remote MCP server for agents on Solana. A user connects an agent once, approves what that client may do and spend, and sees its activity in one app. Success: a user connects an agent and completes a real paid call without local payment tooling, then makes more calls and connects a second client with its own cap.

## Positioning

One hosted MCP URL, one Privy embedded wallet, a separate permission set and spending cap per connected client, and a record of every call, cost, payment, denial, and transaction. Two clients share the wallet with different caps. A failed or unclear payment is checked before anything is charged twice.

## Operating Context

Cursor, Claude Desktop, and cloud agents connecting over remote MCP with OAuth. Paid endpoints discovered through the pay.sh catalog. Data providers Helius, Jupiter, Dune (planned). Prepared transactions returned as review links (Blink-style) signed from a local, browser, or embedded wallet. Privy wallet policies govern what the wallet may sign.

## Capabilities and Constraints

- Available now: pay for allowed endpoints from the embedded wallet within a client's cap; activity record per client.
- Next: payment URL router (selection rules undecided).
- Planned: prepare and send transactions; Solana data tools (Helius, Jupiter, Dune) with provider credit usage shown.
- Small allowed list of endpoints at launch.
- Undecided: pricing, launch date, exact tool names. The MCP URL `https://mcp.lanatools.sh` is a placeholder.

## Brand Commitments

Name: LanaTools. No logo, palette, or type commitments yet. Voice: plain, specific, no hype.

## Evidence on Hand

No customers, testimonials, benchmarks, or live data. Any activity, client, or cost data shown on marketing surfaces is illustrative and must be labeled as such. Existing frontend: `apps/web` (React, TanStack Router, Tailwind v4). Existing API: `apps/api` (Hono) with `/api/health`.

## Product Principles

- Show the record, not the promise: every claim about control is demonstrated with what the user would actually see.
- Per-client limits are the product: caps, permissions, denial, and revocation are first-class, not fine print.
- One connection, growing toolset: tools arrive through the URL the agent already has.
- Never charge twice on ambiguity.
