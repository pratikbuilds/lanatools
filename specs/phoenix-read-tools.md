# Phoenix read tools

Status: built (first slice, read-only)

Agents can read Phoenix perps markets and any wallet's Phoenix account
through LanaTools MCP. Trading is out of scope; it would go through the
spending-limit flow and needs its own design.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Client | Thin `fetch` client + zod, not `@ellipsis-labs/rise` | Rise is pre-1.0 with several releases a day and pins a different `@solana/kit` major; we need only public GETs |
| Vulcan CLI | Not used at runtime | Rust binary with its own keystore; used as the reference for tool scope, names and defaults |
| Network | Mainnet only, no `network` input | Phoenix has no devnet |
| Access | Any active grant, no new scope | Public data, no key, no money moves (same as the catalog tools) |
| Wallet input | Required address, any wallet | Defaulting to the user's embedded wallet can come later |
| Defaults | Order book depth 10, candles 1h × 50, history 20 | Copied from Vulcan; no maximums, since Phoenix publishes none |

## Tools

| Tool | Input | Returns | Phoenix routes |
|---|---|---|---|
| `phoenix_list_markets` | — | Every market by 24h volume: price, change, volume, OI, funding, max leverage | `/v1/view/exchange/markets`, `/v1/markets/stats/latest` |
| `phoenix_get_market` | `symbol` | Stats, fees, leverage tiers (tokens), OI cap, funding limits | `/v1/view/exchange/market/{s}`, `/v1/market/{s}/stats/latest` |
| `phoenix_get_orderbook` | `symbol`, `depth?` | Bids, asks, mid, spread | `/v1/view/orderbook/{s}` |
| `phoenix_get_candles` | `symbol`, `timeframe?`, `limit?` | OHLCV, oldest first | `/v1/candles/{s}` |
| `phoenix_get_account` | `wallet` | Collateral, positions with PnL at mark, open orders, per subaccount | `/v1/trader/state/{w}` (+ market routes when it has positions) |
| `phoenix_get_history` | `wallet`, `type`, `symbol?`, `limit?`, `cursor?`, `resolution?` | trades, orders, funding, collateral or pnl, newest first | `/v1/trader/{w}/*-history`, `/v1/users/{w}/pnl` |

Vulcan tools covered: `market_list`, `market_ticker`, `market_info`,
`margin_leverage_tiers`, `market_orderbook`, `market_candles`, `portfolio`,
`position_list`, `position_show`, `margin_status`, `trade_orders`,
`account_info`, `history`.

## Not included

- Write tools (orders, deposits, withdrawals), auth, TWAP and grid bots.
- Live streams (WebSocket), liquidation prices and margin ratios. These need
  Rise's margin calculator.
- Technical-analysis tools; agents can compute them from candles.

## Checks

- `bun test packages/phoenix/src`
- Live smoke run against `perp-api.phoenix.trade` for every tool and error path
  (2026-10-04).
- MCP SDK in-memory client: lists the six tools and calls them.
