# Phoenix trade tools: tech spec

Status: Phase 1 (foundation) built 2026-10-08, waiting for review. No tools yet.
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
      rise.ts          the only Rise import: client setup + convert its instructions to kit 6
      transaction.ts   build, simulate, send, confirm
      price.ts         size → lots, price → ticks, slippage → limit price (BigInt)
      checks.ts        checks every built instruction before it is returned
      tool.ts          TradeTool type, defineTradeTool, runTradeTool
      index.ts         the `@lanatools/phoenix/trade` entry point
      fixtures.ts      test data: a real Rise market order, sample instructions
      tools/
        activate.ts  deposit.ts  withdraw.ts  market-order.ts  limit-order.ts  cancel.ts  close.ts
      *.test.ts
    index.ts           read tools only (unchanged); trade exports live in trade/index.ts
  scripts/
    trade.ts           the CLI (phase 5)
```

Reading state:

- Trade tools read state (collateral, positions, open orders, book) through the
  **existing** Phoenix API client.
- On mainnet that client agrees with the chain.
- No new RPC readers are needed beyond what Rise and the transaction core use.

## 4. Shared design

### 4.1 Tool contract

```ts
type TradeTool<S extends z.ZodObject> = {
  name: string
  title: string
  description: string
  input: S
  prepare: (ctx: TradeContext, input: z.output<S>) => Promise<PreparedInstructions>
}

type TradeContext = {
  phoenix: PhoenixClient // existing read client (API)
  rise: RiseBuilders     // narrow wrapper from rise.ts, faked in tests
  rpc: Rpc               // kit 6, used only by transaction.ts
}

type PreparedInstructions = {
  wallet: Address
  instructions: Instruction[] // Phoenix (and ATA/token) instructions; no compute budget
  summary: string             // "Buy 0.10 SOL at up to $117.30 (market, IOC)"
  details: Record<string, string>
  warnings: string[]
}
```

`runTradeTool(name, input, opts)` does four steps:

1. Validate the input.
2. Call `prepare`.
3. Run `checks.ts`.
4. Run `transaction.build`.

It returns a `PreparedTransaction`, or `{ ok: false, error }`, the same way
`runPhoenixTool` does. **It never throws.**

```ts
type PreparedTransaction = PreparedInstructions & {
  transaction: string           // base64 v0 wire, unsigned
  lastValidBlockHeight: string
  simulation: { ok: boolean; computeUnits: number; error?: string; logs: string[] }
  submit: Submit                // where the signed transaction goes
}

type Submit =
  | { via: 'rpc' } // every tool except activation
  | { via: 'phoenix-referral'; referralCode: string; login: { message: string; nonceId: string } }
```

Activation is the only tool where Phoenix, not our RPC, sends the
transaction. `sendSignedTransaction` reads `submit` and routes the signed
transaction there:

- `rpc` sends to our RPC.
- `phoenix-referral` sends to Phoenix's referral route. The caller also passes
  a signature of `login.message`.

The caller never picks the route; it comes from the tool.

When simulation fails, the result is still `ok: true`, with
`simulation.ok: false` and Phoenix's log reason. The caller decides whether
to stop. The script always stops.

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

**`sendSignedTransaction(rpc, wire, lastValidBlockHeight)`**

1. Send once, with `skipPreflight: false`.
2. Poll `getSignatureStatuses` until the transaction is `confirmed`, it fails,
   or the block height passes `lastValidBlockHeight`.

It returns `{ status: 'confirmed' | 'failed' | 'expired' | 'unknown', signature, error? }`.

- **It never resends or re-signs.**
- `unknown` means "may have landed": check the signature before trying again.
- It follows the same pattern as `apps/api/src/solana/usdc-transfer.ts`.

### 4.3 Instruction checks (`checks.ts`)

These run on every result before the transaction is built. A failed check is
an error, never a warning.

- Every instruction's program is one of four allowed programs:
  - Phoenix `EtrnLzgb…`
  - Ember `EMBERpYN…`
  - SPL Token
  - Associated Token
- The only signer on every instruction is `wallet`. The one exception is activation, where the Phoenix onboarder also signs (see 5.0).
- Order instructions:
  - The decoded side, size and price limit match what `prepare` computed.
  - The reduce-only flag matches.
  - **The price limit is never null.**

Decoding uses Rise's codecs through `rise.ts`.

### 4.4 Conversions (`price.ts`)

All conversions use BigInt; floats are never used for amounts.

- **Size to lots:** `size × 10^baseLotsDecimals`. The result must be a whole
  number of at least 1, or the tool returns an error that states the lot size.
  We never round size silently.
- **Price to ticks:** use Rise's `priceUsdToTicksWithMarketParams`.
  - Buy limits round **down**, so the buyer never pays more than stated.
  - Sell limits round **up**, so the seller never receives less than stated.
- **Slippage to limit price:**
  - Buy: `bestAsk × (1 + bps/10 000)`.
  - Sell: `bestBid × (1 − bps/10 000)`.
  - Read from `/v1/view/orderbook/{symbol}`.
  - If that side of the book is empty, return an error.
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
| **Input** | `wallet`, `referralCode?` (defaults to the LanaTools code `4L2RQ06K`, kept in one constant, `LANATOOLS_REFERRAL_CODE`) |
| **Reads** | Trader state. If the account is already active, the tool returns `{ status: 'already_activated' }` and no transaction. It also reads the wallet's SOL balance, which must cover rent plus fees. |
| **Builds** | 1. Get a Phoenix login nonce for `wallet` (`/v1/auth/nonce`). 2. `buildActivateReferralTxRequest({ referralCode, traderAuthority: wallet, traderPdaIndex: 0, traderSubaccountIndex: 0, registerTraderMaxPositions: 128n, recentBlockhash, … })` gives unsigned v0 bytes. |
| **Checks** | Every instruction is `RegisterTrader` or `OnboardTraderDelegated` on the Phoenix program, plus System. `RegisterTrader` decodes to PDA 0, subaccount 0, 128 positions, payer = wallet, trader PDA = derived from wallet. The only signers are `wallet` and the Phoenix onboarder from `activation-permission` (which co-signs on their side). Same idea as solOS `phoenix-onboard-guards.js`. |
| **Submit** | `phoenix-referral`: sign the login message and the transaction. Phoenix co-signs and submits. |
| **After submit** | Phoenix responds with `activated`, `submitted` or `already_activated`. We then poll trader state until the account appears. If the HTTP call fails after signing, we report "may have landed" and check state before allowing another try. |
| **Summary** | "Activate your Phoenix trading account (one-time, about 0.028 SOL rent, paid by your wallet)" |

The login signature only proves wallet ownership to Phoenix's API. It moves no
funds, and the summary says so.

### 5.1 `phoenix_deposit`

| | |
|---|---|
| **Input** | `wallet`, `amount` (USDC) |
| **Reads** | Trader state (must be activated) and the wallet's USDC balance |
| **Builds** | `rise.buildDepositIxs({ authority, amount, traderPdaIndex: 0, traderSubaccountIndex: 0 })`: Phoenix USD ATA (idempotent), `EmberDeposit`, `DepositFunds` |
| **Checks** | `amount > 0`, and `amount ≤` the USDC balance |
| **Summary** | "Deposit 100 USDC into your Phoenix cross-margin account" |

### 5.2 `phoenix_withdraw`

| | |
|---|---|
| **Input** | `wallet`, `amount` (USDC) |
| **Reads** | Trader state (collateral), exchange status (`withdrawalsAvailable`) |
| **Builds** | `rise.buildWithdrawIxs(...)`: 5 instructions (ATA, approve, ATA, `WithdrawFunds`, `EmberWithdraw`) |
| **Checks** | `amount ≤` collateral. Margin is enforced on-chain and appears in the simulation. |
| **Warning (always)** | "Withdrawals go through Phoenix's queue and may be delayed or dropped." |

### 5.3 `phoenix_market_order`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `side` (`buy`/`sell`), `size`, exactly one of `maxSlippageBps` or `limitPrice`, with no default (**D1**), `reduceOnly?` |
| **Reads** | Market (lot decimals, tick size, status), order book, trader state |
| **Builds** | `orderPackets.buildMarketOrderPacket({ side, baseUnits, priceLimitUsd, lastValidSlot: observed slot + 16 (D2), orderFlags })`, then `ixs.buildPlaceMarketOrder({ authority, symbol, orderPacket, traderPdaIndex: 0, traderSubaccountIndex: 0 })` |
| **Fill rule** | **D4**: partial fills allowed (`minBaseLotsToFill: 1`). The result never says "filled"; the caller reads the position afterwards to see what filled. |
| **Details** | Limit price, estimated notional at the best price, estimated taker fee (3.5 bps from market data) |

### 5.4 `phoenix_limit_order`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `side`, `size`, `price`, `postOnly?`, `reduceOnly?` |
| **Builds** | `buildPlacePostOnlyOrder` when `postOnly`, otherwise `buildPlaceLimitOrder`. No expiry: limit orders rest until filled or cancelled (**D2** covers IOC orders only). |
| **Warning** | Shown when the price crosses the book and the order isn't post-only: "This limit order will fill immediately as a taker." |
| **Details** | The order ID cannot be known until the order lands. The script reads it afterwards from `phoenix_get_account`. |

### 5.5 `phoenix_cancel_orders`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `orderIds?` (strings from `phoenix_get_account`; omit to cancel all in the market) |
| **Reads** | Trader state, to find each order's price in ticks (Rise needs the price *and* the sequence number) |
| **Builds** | `buildCancelOrdersById` or `buildCancelAll` |
| **Checks** | Every ID is currently open, otherwise `not_found` and the open IDs are listed. Nothing is open: `not_found`. |

### 5.6 `phoenix_close_position`

| | |
|---|---|
| **Input** | `wallet`, `symbol`, `fraction?` (0 to 1, default 1), exactly one of `maxSlippageBps` or `limitPrice` |
| **Reads** | Trader state (position size and direction), market, book |
| **Builds** | A market order on the opposite side, sized `floor(position lots × fraction)`, with `ReduceOnly` always set |
| **Checks** | A position exists, and the computed size is at least 1 lot |

## 6. Script (`packages/phoenix/scripts/trade.ts`)

```
bun packages/phoenix/scripts/trade.ts <command> [args] --rpc <mainnet RPC URL> [--keypair ~/.config/solana/id.json] [--dry-run]
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

1. `runTradeTool`
2. Print the summary, details, warnings and simulation.
3. Stop if the simulation failed.
4. With `--dry-run`, stop here.
5. Otherwise ask you to type `yes`.
6. Sign with the keypair.
7. `sendSignedTransaction`
8. Print the signature, an Explorer link and the new `state`.

**Guards:**

- The RPC's genesis hash must be mainnet.
- `--rpc` is required and has no default.
- `activate` first checks that the wallet is not already activated and holds
  enough SOL.
- **Every send asks for confirmation. There is no `-y` flag.**

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
  - **D5 proposal (needs your approval):** see the D5 row.

### Phase 2: account and collateral tools

- **Build:** `phoenix_activate_account`, `phoenix_deposit`, `phoenix_withdraw`, the submit routing in `sendSignedTransaction`, and the `phoenixTrade` export.
- **Tests:**
  - Activation: already-activated, low SOL, an instruction or signer that fails the checks, each Phoenix response status, and the "may have landed" path.
  - Collateral: input errors, not-activated, insufficient funds, the exact instruction list, summaries and warnings.
- **Check (D7):** mainnet simulation as the public trader address, nothing signed.
- **Exit:** both tools return a checked unsigned transaction in tests.

### Phase 3: order tools

- **Build:** `phoenix_market_order`, `phoenix_limit_order`.
- **Tests:**
  - The limit price comes from the book with the right rounding.
  - Exactly one of slippage or limit price is given.
  - Lot errors, the post-only builder choice, the warning for a crossing limit, and reduce-only flags.
  - The decoded packet matches the input.
- **Check (D7):** mainnet simulation, nothing signed.
- **Exit:** both tools pass the checks; market orders can never be built without a price limit.

### Phase 4: cancel and close

- **Build:** `phoenix_cancel_orders`, `phoenix_close_position`.
- **Tests:**
  - Mapping IDs to prices, and unknown IDs.
  - Cancel-all.
  - Position direction becomes the opposite side; fraction rounding; always reduce-only; no position.
- **Check (D7):** mainnet simulation, nothing signed.
- **Exit:** all seven tools done.

### Phase 5: script

- **Build:** `scripts/trade.ts` with every command, `--dry-run`, guards and confirmations; README section.
- **Tests:** argument parsing and guards (wrong genesis, missing `--rpc`). The `activate` command signs both the login message and the transaction.
- **Verify:** `--dry-run` for each command against mainnet. This simulates only and needs D7.
- **Exit:** the script is ready; nothing has been signed.

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
| D5 | Compute and priority fee | **Decided:** measure compute by simulating; never use a fixed limit like solOS's 500k, which would have failed the 507k order in our spike. **Phase 1 proposal, waiting for approval:** a 20% compute margin and no priority fee for now. Both are settings the caller passes (`FeeSettings`); there are no defaults in code. | — |
| D6 | Mainnet test amounts | **Decided:** you approve a budget for each Phase 6 step, and every lamport is recorded. Activation is about 0.028 SOL; the wallet has 0.0416. | — |
| D7 | Mainnet simulation during phases 2–5 | **Decided:** simulate as a public, already-activated trader address. Read-only, nothing signed. The address is recorded in the spec in Phase 2. | — |
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
