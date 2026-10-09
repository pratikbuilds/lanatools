# Phoenix trade tools: tech spec

Status: Phases 1–5 built (tools and script); Phase 6, the mainnet run, waits for your go and a funded wallet.
Background: [research-phoenix-transactions.md](research-phoenix-transactions.md).

## 1. Goal and scope

Add Phoenix perps write tools to `packages/phoenix`. Each tool turns an agent's
input into checked Phoenix instructions and an **unsigned** mainnet
transaction. A local script signs those transactions with the Solana CLI
wallet and sends them. We run the script **once**, on mainnet, after every
tool is done.

**In scope**

- Tool definitions, instruction building, transaction building and simulation
- Account activation as a tool (`phoenix_activate_account`), with referral
  code `4L2RQ06K`
- The script that drives every tool

**Out of scope**

- API/MCP wiring, scopes and grants
- Review links
- Privy signing
- The activity ledger
- Spending limits
- Surfpool or any local chain
- TP/SL, isolated subaccounts, TWAP, delegated trader, builder fees

**Isolation rules**

1. All Phoenix code, including the Rise SDK, lives in `packages/phoenix`.
   Only one source file, `trade/rise.ts`, imports Rise. Test fixtures may
   import it to encode sample instructions.
2. The package never loads keys, never signs, and never sends on its own.
   Sending is a separate helper that takes an already-signed transaction.
3. Trade tools are **not** added to the existing `phoenix` provider.
   `apps/api` registers every tool in that provider with MCP, and marks all of
   them read-only. Trade tools are exported as a separate `phoenixTrade` set
   that nothing in `apps/` imports.
4. Trade code has its own entry point, `@lanatools/phoenix/trade`. The
   package root (`@lanatools/phoenix`, which `apps/api` imports) stays
   read-only, so it never loads Rise into the API Worker.

## 2. Facts this spec relies on

All checked on 2026-10-08.

| Fact | Evidence |
|---|---|
| A Rise 0.5.38 instruction compiles with our `@solana/kit` 6.10 | Spike. Rise ships its own nested kit 4.0.0. Proven at runtime only. |
| A market order for a real trader simulates and fills on mainnet with no signature | Spike: `simulateTransaction` with `sigVerify: false` |
| Compute is large and varies | That order used 507k CU; the default 200k fails. We must measure compute by simulating. |
| A price limit below the market makes Phoenix reject the IOC | Spike: "IOC order does not meet minimum requirements" |
| Rise leaves market orders uncapped unless `priceLimitUsd` is given | `priceInTicks: null` in the built packet |
| Referral activation runs on mainnet and needs a Phoenix login | Docs `/sdk/register`, `/sdk/auth`. Phoenix co-signs and submits. |
| CLI wallet `Du3X3wKN3LHfSbXtX2PW5jhnSHit8j8NSb19VZW6V9mu` is not activated and has 0.0416 SOL | `/v1/trader/state`, `/v1/invite/check`, `solana balance` |
| Activation cost about 0.0279 SOL rent plus 0.00001 SOL fees | solOS mainnet activation `5gsKNcnP…` (their ADR-0025) |
| solOS activates through the no-code builder route, not a referral code | solOS `phoenix-onboard-*.js`: `build-register-ixs` → check every instruction → sign v0 → `send-register-ixs`. Phoenix co-signs and submits. Their first try with a v1 transaction timed out, so they use v0 for this. |
| Rise returns the referral activation as unsigned bytes | `buildActivateReferralTxRequest` → `unsignedTransactionBase64`. Phoenix responds with `activated`, `submitted` or `already_activated`. |
| Phoenix is `gated: true` and `withdrawalsAvailable: true` | `/v1/view/exchange/status` |

## 3. Package layout

```
packages/phoenix/
  src/
    client.ts, tool.ts, schemas.ts, units.ts, tools/*   existing read code (unchanged)
    trade/
      rise.ts          the only Rise import: resolved (network-free) builders, decoders, kit 4 → kit 6
      transaction.ts   build, simulate, send, confirm
      submit.ts        routes a signed transaction to the RPC or to Phoenix (activation)
      chain.ts         on-chain reads: accounts, token balances
      schemas.ts       Phoenix API responses the trade tools read
      price.ts         size → lots, price → ticks, slippage → limit price (BigInt)
      checks.ts        checks every built instruction before it is returned
      tool.ts          TradeTool type, defineTradeTool, runTradeTool
      index.ts         the `@lanatools/phoenix/trade` entry point
      fixtures.ts      test data: a real Rise market order, exchange keys, fakes
      fixtures/        a real trader account from mainnet
      tools/
        activate.ts  deposit.ts  withdraw.ts  market-order.ts  limit-order.ts  cancel.ts  close.ts
      *.test.ts
    index.ts           read tools only (unchanged); trade exports live in trade/index.ts
  scripts/
    trade.ts           the CLI (phase 5)
```

Reading state:

- **The chain** answers whether an account exists or is activated, and what
  the wallet holds (`chain.ts`).
- **Phoenix's API** answers collateral, positions, open orders, the book and
  the exchange accounts (`/v1/view/exchange/keys`), through the existing
  client, which gained a `post` for login and activation.
- Rise is used only to build and decode. Its own client, which needs an RPC
  URL and fetches metadata, is not used: every account the builders need is a
  derivation or comes from the exchange keys.

## 4. Shared design

### 4.1 Tool contract

```ts
type TradeTool<S extends z.ZodObject> = {
  name: string
  title: string
  description: string
  input: S
  programs?: readonly Address[] // when not the default trade programs
  prepare: (ctx: TradeContext, input: z.output<S>) => Promise<Prepared>
}

type TradeContext = { phoenix: PhoenixClient; rpc: TradeRpc } // kit 6 RPC

type Prepared =
  // Instructions the shared builder turns into a transaction (most tools).
  | (Described & { kind: 'instructions'; instructions: Instruction[] })
  // A whole transaction built elsewhere (activation), checked and simulated as is.
  | (Described & {
      kind: 'transaction'
      transaction: Base64EncodedWireTransaction
      lastValidBlockHeight: string
      coSigners: readonly Address[]
      submit: Submit
    })
  // Nothing to sign, e.g. the account is already activated.
  | { kind: 'nothing_to_do'; wallet: Address; summary: string }

type Described = {
  wallet: Address
  summary: string // "Buy 0.10 SOL at up to $117.30 (market, IOC)"
  details: Record<string, string>
  warnings: string[]
}
```

`runTradeTool(tool, input, opts)` validates the input and calls `prepare`.

- For `instructions`, it runs `checks.ts`, then builds and simulates with
  compute budget instructions.
- For `transaction`, it checks that the wallet pays and runs `checks.ts` on the
  decoded instructions. Then it simulates the bytes as they are.

Its result is `{ status: 'ready', ... }` (below), `{ status: 'nothing_to_do' }`,
`{ status: 'simulation_failed', summary, details, warnings, simulation }` (no
transaction: it would fail as built, and the simulation says why), or
`{ ok: false, error }`, the same way `runPhoenixTool` does. **It never
throws.** `phoenixTrade` lists the tools; the MCP layer can look them up by
name later.

```ts
type PreparedTransaction = Described & {
  status: 'ready'
  transaction: Base64EncodedWireTransaction // v0 wire, unsigned
  lastValidBlockHeight: string
  simulation: { ok: true; computeUnits: number; logs: string[] }
  submit: Submit // where the signed transaction goes
}

type Submit =
  | { via: 'rpc' }
  | { via: 'phoenix-referral'; referralCode: string; recentBlockhash: string; login: { message: string; nonceId: string } }
```

`submitSignedTransaction(prepared, { transaction, loginSignature? }, opts)`
first checks the signed transaction against `prepared.transaction`. The
message bytes must be identical, and the fee payer's signature must verify.
Otherwise nothing is sent: the safety checks only ever saw the prepared bytes.
Then it sends the signed transaction where `submit` says:

- `rpc` sends it to the RPC. It must be fully signed.
- `phoenix-referral`:
  1. Logs in to Phoenix with the wallet's signature of `login.message`.
  2. Posts the wallet-signed transaction to `/v1/referral/activate-tx`.
  3. Waits for confirmation on the RPC.

The caller never picks the route.

### 4.2 Transaction core (`transaction.ts`)

**`build(rpc, { feePayer, instructions, priorityFee })`**

1. Get the latest blockhash at `confirmed` commitment.
2. Build a v0 message with a compute-unit limit of 1,400,000 (the maximum) and
   the chosen priority fee.
3. Simulate with `sigVerify: false` and `replaceRecentBlockhash: false`.
4. Set the compute-unit limit to the measured units plus headroom (**D5**: the exact headroom and priority fee are proposed in Phase 1 for your approval).
5. Compile and return the wire bytes, `lastValidBlockHeight` and the
   simulation result.

No lookup tables, and one transaction per tool call.

**`sendSignedTransaction(rpc, { prepared, transaction, lastValidBlockHeight })`**

1. Check the signed transaction against the prepared one (same message, valid
   fee payer signature, fully signed).
2. Send once, with preflight.
   - Preflight refused it: `failed` (it was never broadcast).
   - Preflight says these exact bytes were already processed: watch for them.
   - Any other send error: watch for them anyway. Watching never sends.
3. Poll `getSignatureStatuses`:
   - A status at `confirmed` or `finalized` decides: `confirmed`, or `failed`
     with the error. **An error seen only at `processed` is not final**: that
     fork may be dropped and the transaction land elsewhere.
   - Past `lastValidBlockHeight`, search history once. If the transaction is
     still missing, ask `isBlockhashValid`. Only a dead blockhash means
     `expired`; a lagging RPC node keeps the watch going.
   - A status that cannot be read is `unknown`, never `failed`.

It returns `{ status: 'confirmed' | 'failed' | 'expired' | 'unknown', signature, error? }`.

- **It never resends or re-signs.**
- `unknown` means "may have landed": check the signature before trying again.

### 4.3 Instruction checks (`checks.ts`)

These run on every result before the transaction is built. A failed check is
an error, never a warning.

- Every instruction's program is one of four allowed programs:
  - Phoenix `EtrnLzgb…`
  - Ember `EMBERpYN…`
  - SPL Token
  - Associated Token
- Nobody but `wallet` signs any instruction. The one exception is activation,
  where the Phoenix onboarder also signs (see 5.0). The wallet always signs as
  the fee payer, so an instruction need not list it.
  - Phase 2 changed this rule. It used to say "the wallet must sign some
    instruction", which wrongly refused a registered-but-not-activated wallet:
    its activation's only instruction lists the wallet nowhere.
- Order instructions (`checkOrder`, any of market, limit or post-only):
  - Every decoded field matches the order spec the tool built from: kind,
    side, price, size, minimum fill, expiry, reduce-only, slide, and
    cancel-existing.
  - **The price limit is never null.**
  - Then the whole instruction data must equal, byte for byte, Rise's
    encoding of the packet we meant. This catches everything else (other flag
    bits, the self-trade rule, match limit, quote lots, trailing bytes).
  - Post-only orders never slide, and no order cancels resting orders on a
    failed margin check.
- Collateral instructions (`checkCollateral`):
  - A deposit is exactly: idempotent token-account create, Ember deposit of
    the amount, Phoenix deposit of the amount.
  - A withdrawal is exactly: create, a token Approve of exactly the amount to
    Ember's state account, create, Phoenix withdrawal of the amount, Ember
    withdrawal of the amount.
- Market accounts: the spline account Phoenix's API names must equal Rise's
  derivation from the market account; otherwise nothing is built.

Decoding uses Rise's codecs through `rise.ts`.

### 4.4 Conversions (`price.ts`)

All conversions use BigInt; floats are never used for amounts.

- **Size to lots:** `size × 10^baseLotsDecimals`. The result must be a whole
  number of at least 1, or the tool returns an error that states the lot size.
  We never round size silently.
- **Price to ticks:** use Rise's `priceUsdToTicksWithMarketParams`.
  - Buy limits round **down**, so the buyer never pays more than stated.
  - Sell limits round **up**, so the seller never receives less than stated.
- **Book prices:** Phoenix's book sends floats with noise (`115.17999999999999`
  for the 115.18 level). Each level snaps to its **nearest** tick before
  anything else uses it, so `0` bps is exactly the best level.
- **Slippage to limit price**, in ticks:
  - Buy: `bestAskTicks × (10 000 + bps) / 10 000`, rounded down.
  - Sell: `bestBidTicks × (10 000 − bps) / 10 000`, rounded up, so it is never
    below one tick.
  - Read from `/v1/view/orderbook/{symbol}`; the best level is the lowest ask
    or the highest bid.
  - If that side of the book is empty, return an error.
- Crossing and out-of-reach warnings compare ticks, never floats.
- **USDC amounts:** convert a decimal string to 6-decimal micro-units, and
  reject anything with more than 6 decimals.

### 4.5 Error codes

These extend `PhoenixErrorCode`:

| Code | When |
|---|---|
| `invalid_input` | The input failed validation, or the size or price is not on the lot or tick grid |
| `not_found` | Unknown market, no position, or an order ID that isn't open |
| `not_activated` | The wallet has no Phoenix trader account |
| `insufficient_funds` | Not enough USDC to deposit, not enough collateral to withdraw, or not enough SOL for fees |
| `market_unavailable` | The market is closed, or that side of the book is empty |
| `check_failed` | A built instruction failed `checks.ts`. This means a bug or an SDK change, never user error. |
| `upstream` / `timeout` / `rate_limited` | Same meaning as in the read client |

Every message says what to do next, for example
`"call phoenix_get_account to see open order IDs"`.

## 5. Tools

All seven take `wallet` (a base58 address that will sign). `symbol` uses the
existing `MarketSymbol` schema. Sizes are token amounts as decimal strings (**D3**).

### 5.0 `phoenix_activate_account`

| | |
|---|---|
| **Input** | `wallet`, `referralCode?` (defaults to `LANATOOLS_REFERRAL_CODE`, `4L2RQ06K`) |
| **Reads** | The trader account on chain: missing, registered, or activated (Phoenix's can-deposit flag). If activated, the result is `nothing_to_do` and nothing else is read. Then, in parallel: exchange keys, `/v1/referral/activation-permission` (the onboarder), a login nonce (`/v1/auth/nonce`), and a finalized blockhash. The wallet's SOL balance is shown in `details`; the simulation decides whether it is enough. |
| **Builds** | Rise `buildReferralActivationTransaction`: `RegisterTrader` (only when missing; PDA 0, subaccount 0, 128 positions), then `OnboardTraderDelegated`. **No compute budget instructions**: Phoenix validates the exact shape. |
| **Checks** | `checkActivation`: the instruction count, Phoenix only, every instruction names the wallet's trader account, `RegisterTrader` decodes to 0/0/128, and the last instruction is `OnboardTraderDelegated`. Signers are the wallet and the onboarder only. |
| **Submit** | `phoenix-referral`: the wallet signs the login message and the transaction. Phoenix co-signs and submits. |
| **After submit** | A failed login means nothing was sent: `failed`. A lost answer from `activate-tx` is `unknown` ("check the account before trying again"). `already_activated` is `failed` (nothing was sent). A different signature from Phoenix is `unknown`. Otherwise we wait for confirmation on the RPC. |
| **Summary** | When registering: "…a one-time account rent of about 0.028 SOL plus the fee, paid by the wallet". When the account is already registered: "Finish activating…: the account already exists, so the wallet pays only the fee". |

The login signature only proves wallet ownership to Phoenix's API. It moves no
funds, and a warning says so.

**Login:** Phoenix's docs page says `activate-tx` needs a login, but its
OpenAPI spec lists no auth and Rise's client sends it without one. We keep
the login: it moves no funds and works either way.

### 5.1 `phoenix_deposit`

| | |
|---|---|
| **Input** | `wallet`, `amount` (USDC) |
| **Reads** | The trader account on chain (must be activated), the wallet's USDC token account, and the exchange keys |
| **Builds** | Rise `buildDepositIxsResolved`: Phoenix USD ATA (idempotent), `EmberDeposit`, `DepositFunds`. `checkCollateral` checks each step's amount. |
| **Checks** | `amount > 0`, and `amount ≤` the USDC balance |
| **Summary** | "Deposit 100 USDC into your Phoenix cross-margin account" |

### 5.2 `phoenix_withdraw`

| | |
|---|---|
| **Input** | `wallet`, `amount` (USDC) |
| **Reads** | Trader state from Phoenix's API (collateral; 404 means not activated), exchange status (`active`, `withdrawalsAvailable`), exchange keys |
| **Builds** | Rise `buildWithdrawIxsResolved`: 5 instructions (ATA, approve, ATA, `WithdrawFunds`, `EmberWithdraw`). `checkCollateral` checks the amounts and that the approval is exactly the amount, to Ember. |
| **Checks** | `amount ≤` collateral. Margin is enforced on-chain and appears in the simulation. |
| **Warning (always)** | "Withdrawals go through Phoenix's queue and may be delayed or dropped." |

### 5.3 `phoenix_market_order`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `side` (`buy`/`sell`), `size` (tokens), exactly one of `maxSlippageBps` (integer, 0–9999) or `limitPrice`, with no default (**D1**), `reduceOnly` (default false) |
| **Reads** | The market config (`/v1/view/exchange/market/{symbol}`: market and spline accounts, tick size, lot decimals, taker fee, status, isolated-only), the book, exchange keys, the current slot, and activation on chain |
| **Refuses** | Markets not `active`, isolated-only markets (9 today, e.g. GOLD; these tools trade cross margin only), an empty side of the book, and sizes off the lot grid |
| **Builds** | Rise `buildPlaceMarketOrderIxResolved` with our own packet. The price limit is set from the best opposite price plus slippage, or from `limitPrice`, with buy rounding down and sell rounding up. It expires at the observed slot + 16 (**D2**), self-trades abort, and `cancelExisting` is false. |
| **Fill rule** | **D4**: partial fills allowed (`minBaseLotsToFill: 1`). Rise's own packet builder defaults to all-or-nothing, so we set it. If nothing fills, Phoenix fails the transaction ("IOC order does not meet minimum requirements"), which the simulation shows. |
| **Details** | Limit price, best price, estimated notional and taker fee at the best price, expiry slot, reduce-only |
| **Summary** | Says long or short: "Market buy (long): 0.1 SOL perp now, paying at most $115.73 each; …". A reduce-only order says "sell to reduce a long position" (or the buy equivalent). |
| **Warnings** | Always: "This order expires about 6 seconds after it was prepared (slot …); sign and send it right away, or prepare it again." A limit beyond the best opposite price: "this order will not fill now". |
| **Fee** | The estimated taker fee is shown to six decimals (a $11.52 order's fee is $0.004031, not "0.00"). |

### 5.4 `phoenix_limit_order`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `side`, `size`, `price`, `postOnly` (default false), `reduceOnly` (default false) |
| **Builds** | Rise `buildPlacePostOnlyOrderIxResolved` (never slides) when `postOnly`, otherwise `buildPlaceLimitOrderIxResolved` (self-trades cancel the resting order). No expiry: limit orders rest until filled or cancelled (**D2** covers IOC orders only). |
| **Warnings** | A price that crosses the book: a limit order "will fill at once as a taker instead of resting"; a post-only order "Phoenix will reject this". |
| **Details** | Tick-rounded price, notional, best opposite price. The order ID is not known until the order lands; the script reads it afterwards from `phoenix_get_account`. |

### 5.5 `phoenix_cancel_orders`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `orderIds?` (1–100 IDs from `phoenix_get_account`; omit to cancel all in the market) |
| **Reads** | The market config (accounts; no tradable check, since cancelling is always allowed), activation on chain, exchange keys, and Phoenix's trader state for the cross account (subaccount 0). Rows marked `change: "closed"` have left the book and are skipped. Isolated subaccounts are not touched. |
| **Builds** | Rise `buildCancelOrdersByIdIxResolved` with each order's `priceTicks` and `orderSequenceNumber` exactly as Phoenix's trader state gives them (a bid's ID is bit-inverted; Rise passes it through as is), or `buildCancelAllIxResolved`. Duplicate IDs are dropped. |
| **Checks** | `checkCancel`: the instruction data equals Rise's encoding of exactly those orders (or of cancel-all). Every ID must be resting, otherwise `not_found`, which lists the open IDs. Nothing resting: `not_found`. |
| **Details** | Each cancelled order: side, size and price. |
| **Warning** | Cancel-all: "This cancels every resting order the account has in this market when it lands, including any placed after this was prepared." |

### 5.6 `phoenix_close_position`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `fraction` (more than 0, at most 1, default 1), exactly one of `maxSlippageBps` or `limitPrice` |
| **Reads** | The tradable market, activation on chain, and Phoenix's trader state for the cross account's position in that market |
| **Builds** | The same immediate-or-cancel order as `phoenix_market_order` (`immediateOrder`): the opposite side, `floor(position lots × fraction)` lots, `ReduceOnly` always set, expiry 16 slots after the observed slot |
| **Checks** | A position exists (`not_found` otherwise), and the share is at least one lot. `checkOrder` checks the order exactly. |
| **Summary** | "Close 0.12 of the 0.25 SOL long: market sell now, receiving at least $114.58 each; reduce-only, so it can never open a short" |

**The position comes from Phoenix's API**, which can lag the chain by moments. Reduce-only makes that safe: whatever the position is when the order lands, the order can only shrink it, never open or flip one. A position that has already closed is not tested here; the simulation shows what Phoenix does.

## 6. Script (`packages/phoenix/scripts/trade.ts`)

```
bun packages/phoenix/scripts/trade.ts <command> [args] --rpc <mainnet RPC URL> [--keypair ~/.config/solana/id.json] [--dry-run [--as ADDRESS]]
```

| Command | Action |
|---|---|
| `activate [--code CODE]` | Trade tool flow for `phoenix_activate_account`. For the referral route, the script also signs the login message. |
| `state` | Prints collateral, positions and open orders (calls `phoenix_get_account`) |
| `deposit <usdc>` / `withdraw <usdc>` | Trade tool flow |
| `market <symbol> <buy\|sell> <size> (--slippage-bps N \| --limit-price P) [--reduce-only]` | Trade tool flow |
| `limit <symbol> <buy\|sell> <size> <price> [--post-only] [--reduce-only]` | Trade tool flow |
| `cancel <symbol> [--id ID …]` | Trade tool flow |
| `close <symbol> [--fraction F] (--slippage-bps N \| --limit-price P)` | Trade tool flow |

**Trade tool flow:**

1. `runPhoenixTrade` (the tool by name).
2. `nothing_to_do`: print it and stop. `simulation_failed`: print the
   reason and stop with an error.
3. Print the summary, details, warnings and simulation.
4. With `--dry-run`, stop here.
5. Otherwise ask you to type `yes`.
6. Sign with the keypair (`scripts/sign.ts`): the transaction partially,
   since Phoenix adds its own signature to activation, and for activation
   the login message.
7. `submitSignedTransaction`
8. Print the result, signature, an Explorer link and the new `state`. An
   `unknown` result says to check the signature before trying again.

**Guards:**

- The RPC's genesis hash must be mainnet.
- `--rpc` is required and has no default.
- `activate` first checks that the wallet is not already activated; the
  simulation decides whether its SOL covers rent and fees.
- **Every send asks for confirmation. There is no `-y` flag.**
- `--as ADDRESS` simulates as another wallet (D7), only with `--dry-run`; no
  key is loaded and nothing can be signed for it.
- Fees are D5's: a 20% compute margin, no priority fee.

## 7. Phases

Each phase ends with a stop: I report what changed, the test output and
anything unverified. You approve before the next phase starts. All phases go in
**one PR** (**D8**), with one commit per
phase on this branch.

### Phase 0: spec sign-off

- **You:** approve this spec (D1–D10 are recorded below).
- **Me:** update the spec with your answers. No code.
- **Exit:** spec marked "approved".

### Phase 1: foundation

- **Build:**
  - Add `@ellipsis-labs/rise` (exact version) and `@solana-program/compute-budget`.
  - `trade/rise.ts`, `trade/transaction.ts`, `trade/checks.ts`, `trade/price.ts`, `trade/tool.ts`
  - New error codes
- **Tests:**
  - `price.ts`: lots, ticks, rounding direction, slippage, USDC parsing, negative-decimal markets such as kBONK
  - `checks.ts`: rejects a wrong program, an extra signer, and a null price limit
  - `transaction.ts`: with a fake RPC, sets the measured CU limit and maps every send outcome
- **You review:** the `rise.ts` boundary (what we use from Rise), and the transaction and check rules.
- **Verify:** `bun test packages/phoenix/src`, `tsc -p packages/phoenix`, lint.
- **Exit:** no tool exists yet; the core is fully covered by tests.
- **Result (2026-10-08):**
  - Rise 0.5.38 (exact) and `@solana-program/compute-budget` ^0.15.0 added.
    Rise's kit 4 types typecheck alongside kit 6.
  - 34 new tests (55 in the package): price, rise boundary, checks,
    transaction, tool runner. All pass; `tsc -p packages/phoenix` and
    `eslint packages/phoenix` are clean.
  - Repo: `bun run test` passes (427). `bun run typecheck` passes.
    `bun run build` passes with `VITE_SOLANA_NETWORK` set; this worktree has
    no env file.
  - `bun run lint` runs out of memory at its 4 GB limit. **This happens on
    `master` too** (same ~4.9 GB peak), so it is not from this change. With
    8 GB the full lint passes with no problems.
  - **Finding for Phase 3:** Rise's market-order packet sets
    `minBaseLotsToFill` to the full size (all-or-nothing) by default. D4
    allows partial fills, so the market tool must pass a minimum of one lot.
  - **D5:** 20% compute margin, no priority fee (approved).

### Phase 2: account and collateral tools

- **Build:** `phoenix_activate_account`, `phoenix_deposit`, `phoenix_withdraw`, the submit routing (`submitSignedTransaction`), and the `phoenixTrade` export.
- **Tests:**
  - Activation: already-activated, low SOL, an instruction or signer that fails the checks, each Phoenix response status, and the "may have landed" path.
  - Collateral: input errors, not-activated, insufficient funds, the exact instruction list, summaries and warnings.
- **Check (D7):** mainnet simulation as public trader addresses, nothing signed.
- **Exit:** both tools return a checked unsigned transaction in tests.
- **Result (2026-10-08):**
  - `phoenix_activate_account`, `phoenix_deposit`, `phoenix_withdraw`,
    `submitSignedTransaction` (RPC and Phoenix referral routes), and the
    `phoenixTrade` list. The Phoenix client gained `post`.
  - 21 new tests (76 in the package), all passing. The package typecheck and
    lint are clean. Repo: `bun run typecheck` passes and `bun run test`
    passes (448).
  - **D7 mainnet simulations, nothing signed:**

    | Tool | Wallet | Result |
    |---|---|---|
    | activate | CLI wallet `Du3X…V9mu` (not activated) | simulates OK, 29,578 CU (solOS measured 28,426) |
    | activate | `DuyJ…vDdm` (active trader) | `nothing_to_do` |
    | deposit 1 USDC | `4WWb…xY2z` (active, holds USDC) | simulates OK, about 28,600 CU |
    | withdraw 1 USDC | `DuyJ…vDdm` / `4WWb…xY2z` | simulates OK, 311,435 / 47,077 CU |
    | deposit / withdraw | CLI wallet | `not_activated` |

  - Withdraw compute varies sixfold between traders, which supports measuring
    over a fixed limit (D5).
  - **Found and fixed:** the signer rule in 4.3 would have refused activation
    for a registered-but-not-activated wallet.
  - **Unverified until Phase 6:** whether `activate-tx` accepts our login and
    transaction. Only Phoenix can say, by submitting.

### Phase 3: order tools

- **Build:** `phoenix_market_order`, `phoenix_limit_order`.
- **Tests:**
  - The limit price comes from the book with the right rounding.
  - Exactly one of slippage or limit price is given.
  - Lot errors, the post-only builder choice, the warning for a crossing limit, and reduce-only flags.
  - The decoded packet matches the input.
- **Check (D7):** mainnet simulation, nothing signed.
- **Exit:** both tools pass the checks; market orders can never be built without a price limit.
- **Result (2026-10-08):**
  - `phoenix_market_order` and `phoenix_limit_order`, Rise's resolved order
    builders, a generic `checkOrder`, and shared inputs and reads
    (`tools/shared.ts`). Deposit now uses the shared activation check.
  - 8 new tests (84 in the package), all passing. The package typecheck and
    lint are clean. Repo: `bun run typecheck` passes and `bun run test`
    passes (456).
  - **D7 mainnet simulations, nothing signed:**

    | Order | Wallet | Result |
    |---|---|---|
    | Market buy 0.01 SOL, 50 bps | `DuyJ…` | fills, 479k CU |
    | Market buy 300 kBONK, 100 bps (negative lot decimals) | `DuyJ…` | fills, 402k CU |
    | Market sell 0.01 SOL, limit $500 | `DuyJ…` | warned "will not fill now"; Phoenix rejects the unfilled IOC |
    | Post-only buy 0.01 SOL at $50 | `DuyJ…` / `4WWb…` | rests, 913k / 208k CU |
    | Post-only buy crossing the book | `DuyJ…` | warned; Phoenix rejects ("would cross the book") |
    | Limit buy just above the best ask | `4WWb…` | fills, 221k CU |
    | Limit sell at $999.995 | `DuyJ…` | rests at $1000 (rounded up), 913k CU |
    | Both slippage and limit, off-grid size, GOLD (isolated-only) | — | `invalid_input`, `invalid_input`, `market_unavailable` |

  - **Finding: very heavy accounts.** `DuyJ…` holds 76 open positions in its
    cross account. Its crossing limit orders run Phoenix out of program memory
    ("memory allocation failed"), even for 0.01 SOL. The same order works for
    `4WWb…`. This is Phoenix's limit, not our builder, and the simulation
    shows it before anything is signed. No change made. A heap-frame request
    could help such accounts later; neither Rise nor solOS uses one.
  - Compute varies about fourfold with the account (208k–913k for the same
    resting order), which again supports measuring it (D5).

### Code review (2026-10-08)

A `/code-review` of phases 1–3 (three reviewers, each finding checked) led
to these fixes. They are described in place above.

| Finding | Fix |
|---|---|
| Book floats could put a 0 bps limit one tick off and hide crossing warnings (seen live on PUMP) | Snap book levels to the nearest tick; slippage, crossing and out-of-reach all work in ticks (4.4) |
| An error seen at `processed` was final `failed` | Only a `confirmed`/`finalized` status decides (4.2) |
| A send could carry a different transaction than the one checked | The signed message must equal the prepared one, with a valid fee payer signature (4.1, 4.2) |
| Resending landed bytes came back `failed` | "Already processed" and other send errors are watched (4.2) |
| A lagging RPC node could make a live transaction look `expired` | `expired` also needs a dead blockhash (4.2) |
| `checkOrder` compared only 9 fields | Plus byte-for-byte equality with the intended packet (4.3) |
| Deposit and withdraw amounts and the approval were not checked | `checkCollateral` (4.3) |
| A failed simulation was still "ready" at the maximum compute limit | New `simulation_failed` result with no transaction (4.1) |
| Fee shown as "0.00"; "at at most"; a sell did not say short; activation always quoted rent; no expiry warning | Wording and warnings fixed (5.0, 5.3, 5.4) |
| Test gaps | Prebuilt transactions, the RPC route, boundary crossings, a registered account, and more: 101 tests |

### Phase 4: cancel and close

- **Build:** `phoenix_cancel_orders`, `phoenix_close_position`.
- **Tests:**
  - Mapping IDs to prices, and unknown IDs.
  - Cancel-all.
  - Position direction becomes the opposite side; fraction rounding; always reduce-only; no position.
- **Check (D7):** mainnet simulation, nothing signed.
- **Exit:** all seven tools done.
- **Result (2026-10-08):**
  - `phoenix_cancel_orders` and `phoenix_close_position`, plus `checkCancel`,
    `fractionOfLots`, the `TraderBook` schema, and shared `marketConfig` and
    `crossAccount` reads.
  - 8 new tests (109 in the package), all passing. The package typecheck and
    lint are clean. Repo: `bun run typecheck` passes and `bun run test`
    passes (481).
  - **D7 mainnet simulations, nothing signed:**

    | Tool | Wallet | Result |
    |---|---|---|
    | Cancel 1 BTC order by ID | a market maker (`1imt…`) | simulates OK, about 280k CU |
    | Cancel all 8 BTC orders | same | simulates OK, about 296k CU |
    | Cancel an unknown ID | same | `not_found`, listing the open IDs |
    | Close half / all of a 0.04 SOL long | `DuyJ…` | reduce-only sell of 0.02 / 0.04, simulates OK, about 472k / 476k CU |
    | Close a 1-lot BTC short | `DuyJ…` | reduce-only buy of 0.0001, simulates OK, about 504k CU |
    | Close half of a 1-lot position | `DuyJ…` | `invalid_input`: less than one lot |
    | Close with no position | `4WWb…` | `not_found` |

  - The market maker's order IDs changed between two reads seconds apart.
    Agents should read open orders right before cancelling by ID; a stale ID
    gets a clear `not_found`.

### Phase 5: script

- **Build:** `scripts/trade.ts` with every command, `--dry-run`, guards and confirmations; README section.
- **Tests:** argument parsing and guards (wrong genesis, missing `--rpc`). The `activate` command signs both the login message and the transaction.
- **Verify:** `--dry-run` for each command against mainnet. This simulates only and needs D7.
- **Exit:** the script is ready; nothing has been signed.
- **Result (2026-10-09):**
  - `scripts/args.ts` (parsing and guards), `scripts/sign.ts` (signing),
    `scripts/trade.ts` (the CLI), a `runPhoenixTrade(name, …)` runner in the
    trade entry point, and a README section. The package tsconfig now covers
    `scripts/`, and the root `bun run test` runs it.
  - 8 new tests (117 in the package): every command's mapping, defaults,
    the required RPC, `--as` rules, worst-price rules, usage errors, and
    signing. The signing tests check that a signed transaction passes the
    send checks and that the login signature verifies.
  - Repo: `bun run typecheck` passes and `bun run test` passes (489).
  - **Dry runs on mainnet, nothing signed:**

    | Command | Wallet | Result |
    |---|---|---|
    | `activate --dry-run` | CLI wallet | ready, simulates OK, 29,540 CU |
    | `deposit 1` | `4WWb…` (`--as`) | ready, 28,683 CU |
    | `market SOL buy 0.01 --slippage-bps 50` | `4WWb…` | ready, 195,543 CU |
    | `limit SOL buy 0.01 50 --post-only` | `4WWb…` | ready, 219,829 CU |
    | `cancel SOL` | `4WWb…` | `not_found` (no resting orders) |
    | `close SOL --slippage-bps 100` | `DuyJ…` | ready, 487,055 CU |
    | `withdraw 1` | `4WWb…` | ready, 47,233 CU |
    | `deposit 1` | CLI wallet | `not_activated` |
    | `state` | CLI wallet / `4WWb…` | "No Phoenix account yet" / the account |
    | any command with `--as` but no `--dry-run` | — | refused |
    | `--rpc` devnet | — | refused: not mainnet |

  - CLI wallet balance on 2026-10-09: 0.0416 SOL and 0.07 USDC.

### Phase 6: mainnet run

Only when you say go. Each step needs your typed `yes` in the script.

1. **Fund the CLI wallet** (you do this): SOL for rent and fees, and USDC to deposit (**D6**).
2. `activate --code 4L2RQ06K`, then `state`.
3. `deposit <D6 amount>`, then `state`.
4. `market SOL buy <min size> --slippage-bps <D1>`, then `state`.
5. `limit SOL buy <min size> <far below market> --post-only`, then `state` (note the order ID).
6. `cancel SOL --id <id>`, then `state`.
7. `close SOL --slippage-bps <D1>`, then `state`.
8. `withdraw <remaining>`, then `state`.

- **Record:** signatures and results go in the spec's "Checks" section. No screenshots.
- **Exit:** the spec is marked "built", and the single PR is opened with every phase's results (**D8**).

## 8. Decisions

| # | Question | Options | My suggestion |
|---|---|---|---|
| D1 | Market and close slippage | **Decided:** every market and close order needs `maxSlippageBps` or `limitPrice`, with no default. Same as solOS, which requires a limit price. | — |
| D2 | Order expiry | **Decided:** IOC orders (market, close) expire at observed slot + 16, as in solOS. Limit orders have no expiry. | — |
| D3 | Size unit | **Decided:** token amounts. A USD-notional input and a leverage cap come later. | — |
| D4 | Market fill rule | **Decided:** partial fills allowed, minimum 1 lot, as in solOS. Results report the actual fill. | — |
| D5 | Compute and priority fee | **Decided:** measure compute by simulating; never use a fixed limit like solOS's 500k, which would have failed the 507k order in our spike. **Approved 2026-10-08:** a 20% compute margin and no priority fee for now; revisit if the mainnet run lands slowly. Both are settings the caller passes (`FeeSettings`); there are no defaults in code. | — |
| D6 | Mainnet test amounts | **Decided:** you approve a budget for each Phase 6 step, and every lamport is recorded. Activation is about 0.028 SOL; the wallet has 0.0416. | — |
| D7 | Mainnet simulation during phases 2–5 | **Decided:** simulate as a public, already-activated trader address. Read-only, nothing signed. Addresses used: `DuyJffWSmNtaauW2UDiULLUeT1J57UQWphUoZCwvvDdm` (withdraw, already-active), `4WWbYhZR2iT3ZyGHC5G6saVczHZeoPFXEe2zKdQCxY2z` (holds USDC: deposit), and our CLI wallet for activation. | — |
| D8 | PRs | **Decided:** one PR for all phases. Each phase is one commit and still stops for your approval. | — |
| D9 | Referral code | **Decided:** `4L2RQ06K` is the LanaTools code and the default for every activation. | — |
| D10 | Activation route | **Decided:** referral route only. There is no builder-route fallback; if the referral route fails in Phase 6, we stop and discuss. | — |

## 9. Risks and unverified items

- **Rise and kit 6 types.** They work at runtime but are untested at type level. `rise.ts` adapts them. If the adapter gets large, we stop and discuss.
- **Can Rise take an injected `fetch` and RPC?** Unknown. Tests fake our `rise.ts` wrapper instead, so this doesn't block testing.
- **Rise is 0.x.** We pin the exact version. Upgrading is a deliberate change that reruns the D7 simulations.
- **Activation:** whether the referral route accepts the CLI wallet, and the exact rent for our wallet. We'll know in Phase 6, step 2. The script checks state before and after.
- **Withdrawal queue.** The final withdraw may queue. The script reports the queued state rather than treating it as a failure.
- **Public RPC limits.** Use your own mainnet RPC URL for `--rpc`.
