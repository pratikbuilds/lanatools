# Dashboard: swaps, perps and the Phoenix account

Status, October 11, 2026: P0 mockup at
[mockups/dashboard-trading.html](mockups/dashboard-trading.html) approved.
P1 to P5 built, each checked with `bun run check` and committed separately;
P3 and P4 also checked live against mainnet (Jupiter swaps, Phoenix wallets
and candles). No real swap or perp order has been placed through LanaTools
for this work. Builds on
[dashboard-transactions.md](dashboard-transactions.md),
[phoenix-trade-tools.md](phoenix-trade-tools.md) and
[phoenix-read-tools.md](phoenix-read-tools.md).

## 1. Goal

1. **Transactions tab.** A Jupiter swap reads as what went in and what came
   out. A Phoenix perp row reads as the trade: "Buy 0.1 SOL-PERP, filled at
   $109.60". Each kind opens its own drawer: an in/out card for swaps, an
   order ticket and the current position for perps.
2. **Phoenix account page.** `/dashboard/perps/<address>` shows one wallet's
   Phoenix account: account value, a candlestick chart with entry,
   liquidation and order lines, the position, open orders and fills. It
   defaults to the embedded wallet and works for any address, so a wallet an
   agent trades from locally can be viewed too.

## 2. Today (facts this spec relies on)

- `AgentTransactionItem` carries only the review (`title`, `description`,
  `fields: {label, value, icon?}[]`). The web page guesses amounts from
  label strings (`transactionAmounts`, `apps/web/src/lib/transactions.ts:163`).
  Nothing branches on the tool.
- Jupiter's review fields are strings ("1 USDC"). Mints are in
  `arguments_json`. Symbols and decimals are only inside those strings.
- Phoenix's prepared `details` are `Record<string, string>` with raw keys
  (`limitPrice`, `estimatedNotionalUsd`, …), flattened into review fields
  (`packages/phoenix/src/trade/operation.ts:124`). The structured details are
  not stored.
- `TransactionReceipt` is `{signature, slot, commitment}`. Confirmation reads
  `getSignatureStatuses` only, so no agent transaction is ever fetched after it
  lands. The actual swap output and the perp fill price are unknown.
  `wallet-transfers.ts` already parses a `getTransaction` result into
  per-mint changes (`walletChanges`).
- `phoenix_get_account` returns positions (entry, mark, notional, uPnL,
  funding), open orders and collateral. It has no liquidation price or
  leverage. `phoenix_get_history` `trades` returns fills with `signature`,
  price, fee and realized PnL. `phoenix_get_candles` returns OHLCV.
- Rise's margin calculator computes liquidation prices in USD and margin
  totals from `/v1/trader/state` with pure maths and no RPC:
  `buildTraderMarginInputsFromSnapshot` → `createMarginCalculator(markets,
  spotCollaterals)` → `computeTraderLiquidationPricesFromInputs` /
  `computeTraderMarginFromInputs`. Its `MarketParams` must be built from
  `/v1/view/exchange/markets` plus mark prices; the SDK's own store expects a
  different response shape. SOL spot collateral is ignored unless spot
  collateral params are passed. There is no leverage field; it is
  Σ position value ÷ effective collateral.
- `packages/phoenix/src/trade/rise.ts` is the only file that imports Rise.
  The read tools do not load it.
- The dashboard has no Phoenix route. Phoenix reads go only through MCP
  (`phoenix:read`), always on mainnet.

## 3. Decisions

| #   | Decision | Choice (recommended; please confirm or change) |
| --- | -------- | ---------------------------------------------- |
| D1  | How the page knows what a transaction is | Tools add a typed `trade` summary to their review: `TransactionReview.trade?: TradeSummary`. It is stored inside the existing `review_json` / `candidate_json`, so no migration. The arguments stay private. |
| D2  | Rows created before this ships | No `trade`, so they keep today's generic rendering. Product is pre-launch, so no backfill. |
| D3  | `TradeSummary` shape | `swap`: venue, pay `{mint, symbol, amount, icon}`, receive `{mint, symbol, estimated?, minimum?, icon}`, `maxSlippageBps`. `perp`: venue, `action` (order, close, deposit, withdraw, cancel, activate), `symbol?`, `side?`, `orderType?`, `size?`, `limitPrice?`, `worstPrice?`, `bestPrice?`, `notionalUsd?`, `feeUsd?`, `reduceOnly?`, `postOnly?`, `amountUsdc?`, `closing?`, `cancelled?`. Decimal strings, never floats. |
| D4  | Actual swap output | The first time the dashboard reads a confirmed swap on its own (`GET /api/transactions/:id`, when its drawer opens), read the transaction once (`getTransaction`, parsed with the existing `walletChanges`) and store the signer's net change of the output mint in the receipt. The agent's send path is not slowed. Until then the row shows "≈ estimated". |
| D5  | Perp fill price, fee, realized PnL | The same read looks a confirmed perp order's signature up in Phoenix trade history and stores the summed fill in the receipt. If Phoenix has not indexed it yet, the receipt is unchanged and the next read tries again. |
| D6  | Where D4 and D5 are stored | Optional fields on `TransactionReceipt` (`received?`, `fill?`). Same `receipt_json` column, no migration. |
| D7  | Perp amount column | The order's notional, unsigned and in normal weight with "notional" under it, since no wallet money moves. A deposit to Phoenix is `−USDC`, a withdrawal `+USDC` in lime, as wallet money. Cancel and activate show "—". |
| D8  | Kind filter | Add "Swaps" and "Perps" to the kind select, filtering agent rows by tool name. |
| D9  | Account page address | `/dashboard/perps/$address`. `/dashboard/perps` redirects to the embedded wallet. Any valid Solana address is accepted. Phoenix data is public, so there is no ownership check. |
| D10 | Navigation | Not in the nav. Reached from perp rows and drawers ("Open account →"). |
| D11 | Account API | Privy-authed `GET /api/phoenix/account/:address` (positions, orders, collateral, liquidation prices, leverage, risk state), `GET /api/phoenix/candles/:symbol?range=1D\|1W\|1M`, `GET /api/phoenix/fills/:address?cursor`. Upstream errors become 502s without leaking URLs, as `wallet-balances.ts` does. |
| D12 | Liquidation and leverage | Read from Phoenix's own trader view, `GET /v1/view/trader/<trader account>`, which returns each position's liquidation price and the account's margin and risk state (found while building P4; it replaces running Rise's margin calculator ourselves, and matches Phoenix's app by construction). The trader account is derived per subaccount (seeds `trader`, wallet, 0, subaccount), so isolated positions get theirs too. Phoenix's `-1` means no liquidation price and shows as none. Leverage is Σ position value ÷ account value. |
| D13 | Chart | TradingView Lightweight Charts 5.2.1 (Apache-2.0), with the TradingView attribution logo left on as its licence asks. Candles: 1D = 96 × 15m, 1W = 168 × 1h, 1M = 180 × 4h. Entry, liquidation and order price lines. Drag, wheel and pinch zoom; a "Show/Hide liquidation" toggle widens the fitted range to reach it. Loaded only on the perps route. |
| D14 | Refresh | Account every 15 s while the page is visible (as the Transactions list). Candles on range change and every 60 s. Please confirm these numbers. |
| D15 | "Placed by" on fills | A fill whose signature matches one of this user's `transaction_request` rows shows that client's name; otherwise "Outside LanaTools". Only the signed-in user's own rows are matched. Resting orders carry no signature in Phoenix's data, so the orders table has no "Placed by". |
| D16 | Network | Phoenix is mainnet only, as the read tools. A devnet wallet usually has no Phoenix account and gets the empty state. E2E tests use fixtures. |
| D17 | Out of scope | Placing, cancelling or closing from the dashboard (agents trade), isolated margin, TP/SL, PnL history chart, funding and deposit history tabs, live WebSocket prices. |

## 4. Phases

Each phase is one commit. I stop and report after each; the next starts on
your go.

### P1. Typed trade summary

- `packages/contracts`: `TradeSummary` (arktype), `TransactionReview.trade?`.
- `packages/jupiter/src/transaction.ts`: `describeSwap` and `withQuote` set
  `trade` (symbols, mints, icons, decimal amounts from the quote's
  `TokenAmount`).
- `packages/phoenix/src/trade`: each tool returns a typed summary alongside
  its string `details`; `operation.ts` puts it on the review. Pre-build
  reviews get it from the arguments.
- API passes it through unchanged (`projectTransactionLink`).
- **Tests:** unit tests per tool for the summary; contract round-trip; an
  API list test showing `review.trade`.
- **Gate:** `bun run check` passes (or report which suites could not run).

### P2. Transactions rows and drawers

- `apps/web/src/lib/transactions.ts`: title, detail line and amounts from
  `review.trade`, falling back to today's code when it is missing.
- `components/dashboard/transactions.tsx`: swap stacked amount; perp title,
  detail and notional; the swap in/out drawer card; the perp order ticket;
  deposit and withdraw copy; an "Open account →" link to
  `/dashboard/perps/<signer>`.
- D8 kind filter (API `tool` family filter plus the select).
- **Tests:** unit tests for the row text; `tests/e2e/transactions.spec.ts`
  extended with swap and perp fixtures at 390 and 1440 px.
- **Gate:** checks pass, plus a local screenshot review (not committed).

### P3. Fill facts after confirmation (D4, D5)

- `TransactionReceipt.received?` and `fill?`.
- On first confirmed observation: swaps read the transaction and store the
  net output; perp orders look up the Phoenix fill by signature.
- Rows and drawers switch from "≈ estimated" / "at most" to actual values.
- **Tests:** observation tests with faked RPC and Phoenix responses,
  including "not indexed yet".
- **Gate:** checks pass. One real devnet swap is not possible (Jupiter is
  mainnet only); verify against a recorded mainnet transaction fixture.

### P4. Phoenix account API (D11, D12, D15)

- `packages/phoenix/src/account-view.ts`: `readPhoenixAccount`, from the
  trader state, Phoenix's trader view per active subaccount, market configs
  and marks.
- `apps/api/src/routes/phoenix.ts`: the three routes; fills joined to the
  user's transaction signatures.
- Contracts for the three responses.
- **Tests:** the reader against responses recorded from a live wallet;
  fills, placed-by matching and candles with fakes.
- **Gate:** checks pass, plus live mainnet reads: wallet
  `TEY5zgBjT247DQ5n9EiHrLmHW6TZmxRFRqLqGf4FQNQ` (one SOL short) and a wallet
  with 82 cross positions, and all three candle ranges.

### P5. Phoenix account page (D9, D10, D13, D14)

- Route `routes/_account/dashboard/perps.$address.tsx` and the `/perps`
  redirect; loading skeleton branch in `routes/_account/dashboard.tsx`.
- Page: account strip, chart card (market tabs, range, toggle, reset,
  position panel with room-to-liquidation bar), positions, open orders,
  fills. Empty state for a wallet with no Phoenix account.
- `lightweight-charts` dependency, lazy-loaded.
- **Tests:** component tests; a new mocked e2e spec at 390 and 1440 px,
  light and dark, including zoom and the liquidation toggle.
- **Gate:** checks pass, local screenshot review, then a PR.

## 5. Open questions

1. D4 and D5 add one read per confirmed swap or perp order. Fine, or show
   estimates only?
2. D14 refresh intervals (15 s account, 60 s candles).
3. ~~P4 gate wallet~~: found public mainnet wallets with open positions.
