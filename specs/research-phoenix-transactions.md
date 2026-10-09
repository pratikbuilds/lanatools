# Research: Phoenix transaction tools

Status: research, 2026-10-08. No decisions are final. Nothing is built.

The goal is to let agents trade Phoenix perps through LanaTools. This note
records what Phoenix supports, what we already have, what solOS does, and the
options to decide on before planning.

## What Phoenix perps lets you write

Phoenix perps runs one mainnet program, `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`.
Collateral is USDC, which the Ember program wraps 1:1 into PhUSD. Phoenix has no
devnet.

| Action | How | Signer |
|---|---|---|
| Activate account | Gated. `POST /v1/exchange/build-register-ixs` returns instructions. You sign them, then `POST /v1/exchange/send-register-ixs`, and Phoenix co-signs. The other paths need an access code or a referral code. | Wallet |
| Deposit | USDC → PhUSD → trader account (Rise `buildDepositIxs`) | Wallet |
| Withdraw | 5 instructions through a global withdraw queue. A withdrawal can wait in the queue or be dropped. | Wallet |
| Market order | `PlaceMarketOrder` (IOC). **With no price limit, the price is uncapped.** | Wallet or delegated trader |
| Limit / post-only / FOK | `PlaceLimitOrder`, `PlacePostOnlyOrder`, `minBaseLotsToFill` | Wallet or delegated trader |
| Cancel | `CancelOrdersById`, `CancelUpTo`, `CancelAll` (per market) | Wallet or delegated trader |
| Close position | No instruction. Use a reduce-only IOC with a price limit. | Wallet or delegated trader |
| TP/SL | Conditional-order instructions. The conditional-orders account needs rent. Default SL slippage is 10%. | Wallet or delegated trader |
| Isolated margin | Subaccount > 0 plus `TransferCollateral` | Wallet |
| TWAP | Flicker program, on chain | Wallet |
| Leverage | **No instruction.** Leverage follows collateral vs size, capped per market (SOL/ETH 25x, BTC 40x). | — |

Useful facts:

- **No modify instruction.** To change an order, cancel it and place a new one.
- **Order safety flags** the protocol supports: price limit, `ReduceOnly`, `lastValidSlot` expiry, FOK, and self-trade behaviour.
- **Delegated trader ("position authority")** is a key that can trade but cannot deposit or withdraw.
- **Costs:**
  - Fees are 3.5 bps taker and 0.5 bps maker.
  - The smallest order is one base lot (SOL 0.01).
  - A market order uses about 159k CU, and no lookup tables are needed.
  - The fee payer pays about 0.038 SOL rent for a trader account, plus ATAs.
- **Rise SDK** (`@ellipsis-labs/rise` 0.5.38) only builds instructions; it does not send them. It depends on `@solana/kit` ^4, but we use ~6.10. It is pre-1.0 and has had 95 releases since April. There is no public IDL, so we would use Rise's encoders rather than hand-writing them.
- **Phoenix server-side builders** (`/v1/ix/*`) cover only isolated orders and TP/SL, and they need a bearer token. For anything else we build instructions ourselves.

Sources: Rise 0.5.38 source on unpkg, docs.phoenix.trade (`/llms.txt`,
OpenAPI), `Ellipsis-Labs/rise-public`, `Ellipsis-Labs/vulcan-cli`, live
`perp-api.phoenix.trade`.

## What we already have

- **Read tools.** `packages/phoenix` has six read tools against `perp-api.phoenix.trade`, behind the `phoenix:read` scope.
- **A prepare → sign → send template: the USDC withdrawal.**
  - `apps/api/src/solana/usdc-transfer.ts` builds a v0 message, checks the exact instruction shape after the user signs, sends it, and polls for confirmation.
  - The user signs in the web modal with the Privy embedded wallet.
- **Server-side signing exists only for Pay Kit payments.** The Privy policy allows USDC `TransferChecked` only. `docs/privy-wallet-access.md` says never to reuse that signer for other transactions.
- **Every tool is registered as read-only** (`packages/toolkit/src/mcp.ts`). Write tools need per-tool annotations.
- **No review link, no approval page, and no transaction ledger yet.** Withdrawals are not recorded in activity.
- **The network mismatch.** Local dev runs on devnet, but Phoenix is mainnet only.

## What solOS does (inspiration, not a template)

solOS implements Phoenix onboarding, deposit, withdraw, and IOC open/close.
It does not do limit orders, cancels or TP/SL.

**Worth taking:**

- **Builders return instructions only.** One shared step simulates, signs, sends and confirms.
- **A preview and an execute path that share the same input and builder,** so they cannot drift apart.
- **Every order needs a price limit.** Close is reduce-only, and orders expire with `lastValidSlot`.
- **Lot and tick math in BigInt.** Round so the user never pays more than they asked.
- **Decode the built instruction back** and check its price, size, flags and signer before signing.
- **Never retry an unclear send automatically.** Report "may have landed" with the signature.
- **Errors name the next tool to call.**

**Too much for us:**

- Effect layers
- A separate `Action` union package
- Executor and submitter ports, plus a dispatcher switch
- Named submission modes
- Three blockhash rechecks
- v1-only transactions
- The agent harness and model router

solOS also has **no spending limits or user approval** on purpose. That is the
part we must design ourselves.

## Options

### 1. Who signs

| Option | How | Good | Cost |
|---|---|---|---|
| A. Review link | The tool saves the intent and returns a link. The user opens LanaTools, sees a fresh simulation, and signs with the embedded wallet. Same pattern as withdrawal. | Matches product §3. No new signer or policy. The user sees every trade. | Not autonomous. A person must click every time. |
| B. Server signer with a Phoenix policy | A second Privy signer that may only call the Phoenix program, checked against our ledger | Autonomous | New policy and signer. Privy limits apply per instruction, so the totals must live in our ledger. Needs a cap model for leverage. |
| C. Delegated trader key | Make a server key Phoenix's position authority. It can trade, but it cannot withdraw. | Autonomous, and the worst case is bad trades, not drained funds | Needs a delegation setup transaction and key custody. The 0.x SDK path is less proven. |

**Recommendation: start with A.** It needs no new signer and follows the product
description. Add C later for autonomous trading, because the protocol itself
prevents withdrawals.

With A, save the **intent**, not the transaction bytes. A blockhash lasts
about 60 s, and the user may open the link later. Build and simulate again when
the user opens the review page.

### 2. Tool scope for a first slice

| Tool | What it does |
|---|---|
| `phoenix_deposit` | USDC → collateral |
| `phoenix_withdraw` | Collateral → USDC, and warns about the queue |
| `phoenix_place_order` | Market or limit, buy or sell, size in tokens or USD, required slippage or limit price, reduce-only and post-only flags |
| `phoenix_cancel_orders` | By order IDs, or all orders in a market |
| `phoenix_close_position` | Reduce-only IOC with a price limit; full or partial |
| `get_transaction_status` (generic) | Status of a prepared or sent transaction |

**Later:**

- TP/SL
- Isolated subaccounts
- TWAP
- Delegated trader (option C)
- Flight builder fees, which could earn revenue on volume

**Account activation:**

- Activation is gated. We could do it once in the web app instead of exposing it as an agent tool.
- First we must check whether the no-code builder path accepts us.

### 3. Where code lives

- **`packages/phoenix`.** Add write tools that turn input into instructions plus a human summary. They take no signer, RPC send or database.
- **`apps/api`.** Generic transaction work:
  - save the intent
  - build the v0 message
  - simulate
  - check the signed bytes
  - send and confirm
  - record activity

  This generalises the withdrawal code; it does not copy it.
- **`apps/web`.** One review page, `/review/:id`.
- **`packages/contracts`.**
  - A `phoenix:trade` scope. Read stays `phoenix:read`.
  - A transaction activity item.
- **`packages/toolkit`.** Per-tool annotations (`destructiveHint` for writes).

### 4. Rise SDK

| Option | Good | Cost |
|---|---|---|
| Use Rise's `build*IxResolved` builders, pinned to an exact version | Phoenix maintains the encoders | It brings in a second `@solana/kit` (4.x). Instruction types need a small adapter, and we need a test against kit 6. |
| Write our own encoders | No dependency | There is no public IDL, so this is fragile and could silently go wrong |

**Recommendation: use Rise for instruction building only, pinned exactly.**
Prove it works with kit 6 in a short spike first.

### 5. Testing without a devnet

Superseded (2026-10-08): no Surfpool. We test with unit tests and mainnet
simulation, then run once on mainnet. See
[phoenix-trade-tools.md](phoenix-trade-tools.md).

- **Surfpool mainnet fork** (we already use Surfpool in the testbed). Clone the Phoenix accounts and simulate orders.
- **LiteSVM** with Phoenix `.so` files dumped from mainnet. Rise has fixtures for this.
- **Phoenix "beta" program** `phDEVv4w…` on mainnet with a test USDC mint. It is not yet checked whether we can use it.
- **A final small mainnet run** with real funds before release.

## Open questions for the user

1. **Signing.** Should the first slice use review links only (A), or do agents need to trade without a click from day one?
2. **Limits.** How should a trade count against a client's spending limit: deposit amount, order notional, or a separate trading cap? (No caps are assumed here.)
3. **Activation.** Should activation be a one-time web step or an agent tool? Do we have a Phoenix access or referral code, or are we going for builder access?
4. **Scope.** Is the first slice deposit, withdraw, order, cancel and close, or smaller (for example, deposit and market orders only)?
5. **Rise.** Is it OK to depend on a 0.x SDK that brings in its own kit 4?

## Not verified

- Whether `send-register-ixs` accepts any caller or only registered builders.
- Whether `/v1/ix/*` really enforces its bearer token.
- Whether Rise works correctly with `@solana/kit` 6.
- Whether the beta program and test mint are open to us.
- Rent for TP/SL and TWAP accounts.
- Phoenix API rate limits.
