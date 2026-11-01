# Phoenix isolated margin, TP/SL and SOL collateral: tech spec

Status: phases 1–6 built 2026-11-01, tested and simulated. Nothing has been signed; Phase 7 is the live run.
Builds on: [phoenix-trade-tools.md](phoenix-trade-tools.md). Its tool contract and error codes still apply.

## 1. Goal and scope

Let agents trade Phoenix with isolated margin, protect positions with take profit (TP) and stop loss (SL), and use SOL as collateral.

Today, isolated positions can only be read, TP/SL does not exist in our tools, SOL cannot be deposited, and 13 of 104 markets cannot be traded at all because they are isolated-only.

**The rule for this work: we do not hand-build transactions.** This is customer money, so every instruction comes from Rise, Phoenix's own SDK, or from Phoenix's server through Rise. We use them the way Phoenix documents them. Our code decides what to ask for, then checks what came back.

**In scope**

- Open, close and manage isolated positions, including the 13 isolated-only markets
- Add margin to an open isolated position
- Set and cancel TP/SL on an open position, cross or isolated, full or partial
- Open a position with TP/SL in the same transaction
- Deposit and withdraw SOL as collateral, and fund isolated positions with it
- Show TP/SL in `phoenix_get_account` and on the dashboard

**Out of scope**

- Taking margin out of an open isolated position
- TP/SL on resting limit orders (**D7**); agents set it after the fill
- TWAP, scale orders, delegated traders, builder fees
- A leverage input (**D3**)
- cbBTC collateral. Phoenix's assets list has it, but you asked for SOL
- Swapping SOL and USDC inside Phoenix (`buildSwapNativeIx`)
- Any TP/SL logic of ours. Phoenix holds and fires the triggers; we never watch prices

The existing rules stay: only `trade/rise.ts` imports Rise, nothing in the package signs, and read tools never load Rise.

## 2. What we checked

All on 2026-11-01. Simulations were unsigned and used public wallets, as in the earlier spec's D7.

| Fact                                                     | Evidence                                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13 of 104 markets are isolated-only, all active          | Live `/v1/view/exchange/markets`: PONS, BP, ORE, GOLD, DRV, COPPER, METADAO, ANTHROPIC, SKR, WTIOIL, SILVER, ANSEM, STONK                                                                 |
| Rise's client builds an isolated order with TP and SL    | `client.api.orders().placeIsolatedMarketOrder()`, 0.01 GOLD, 2 USDC, wallet `4WWb…`: built, and our price limit and 1-lot minimum fill came back in the order                             |
| That order simulates in one transaction                  | 9 Phoenix instructions, 861 bytes, 186,869 CU, no lookup tables (same request through the raw route)                                                                                      |
| TP/SL on an existing position simulates                  | Rise's `placePositionConditionalOrder`, wallet `DuyJ…`: about 33,000 CU                                                                                                                   |
| Partial TP/SL simulates                                  | On a 19-lot ADA long: TP 50%, TP 3 lots, SL 25%, TP and SL sharing 50%, and two separate TPs in one transaction all passed. Firing is not tested.                                         |
| Closing isolated returns the collateral in one step      | Reduce-only STONK close, wallet `DuyJ…`: 5 instructions, 167,520 CU, sweep runs after the fill                                                                                            |
| SOL deposit simulates                                    | Rise's `buildReallocTraderIx`, `buildTransferSolIx`, `buildSyncNativeIx`: 19,771 CU                                                                                                       |
| SOL withdrawal simulates                                 | Rise's `buildWithdrawNativeSolIx`, after a deposit in the same simulation: 36,637 CU in total                                                                                             |
| SOL alone can fund an isolated position                  | 0.05 SOL backed 0.01 GOLD (about $39 notional), 171,963 CU. 0.01 SOL failed the margin check. USDC and SOL together also passed.                                                          |
| SOL's collateral terms                                   | Live `/v1/collateral/assets`: 20% margin discount, 1,000 SOL per trader, 50,000 SOL exchange-wide, about 9,550 used                                                                       |
| SOL deposits can be credited short                       | Rise docs: `SyncNative` clamps to the caps instead of failing, so lamports over the cap land uncounted. Rise gives `nativeSolCollateralHeadroomLamports` to size the deposit.              |
| Signing policy does not change                           | Isolated and TP/SL use only the Phoenix program. A SOL deposit also uses the System program, which `transactionPrograms()` already includes for `solana_transfer`                         |
| Rent is small                                            | First isolated order with TP/SL: about 0.008 SOL. TP/SL account alone: about 0.0057 SOL. No way to get it back was found (**Q3**).                                                                |
| Phoenix refuses isolated on top of cross in one asset    | Its 400 names `allow_cross_and_isolated_for_asset`                                                                                                                                        |
| The build routes answered without login                  | HTTP 200 with no token, although Phoenix's docs describe Bearer auth. Rise's client has an `auth` option if this changes (**Q4**).                                                        |
| The old stop-loss API is deprecated                      | Rise changelog: use the conditional-order APIs. `placeStopLossOrder` and `tpSl` are not used.                                                                                             |
| Trader state already carries triggers                    | Each position row has four trigger lists. All were empty on the wallet read, so the filled-in shape comes from Rise's types only.                                                         |

**Not known yet**

- **How long a trigger takes to fire** (**Q1**), and **whether a missed stop is retried** (**Q2**).
- Whether a partial TP/SL closes only its share. Phoenix's docs describe only full closes, so reviews warn, and Phase 7 fires one. On order entry, TP/SL is full-position only.
- **Explained in Phase 4: the AMZN failure.** `InvalidInstructionData` is how Phoenix reports "Conditional order must be in opposite direction of trader position". That wallet's AMZN position had flipped, so the triggers fired on the position's own side. Size, entry and distance from mark do not cause it. No position gives `InvalidAccountData`.
- **Answered in Phase 4: a cancel's index.** It is a slot in the on-chain TP/SL account, not `conditionalStopLossId`. `disableFirst` is the greater leg and `disableSecond` the less, shown by simulating Phoenix's route on a live position.

## 3. Design

### 3.1 Where instructions come from (D1)

| Action                                  | Source                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Isolated market and limit orders        | Rise `client.api.orders().placeIsolatedMarketOrder` / `placeIsolatedLimitOrder`         |
| TP/SL on a position, and cancelling it  | Rise `placePositionConditionalOrder` / `cancelConditionalOrder`                         |
| Close an isolated position | Rise's order builder and sweeps. Phoenix's route picks the subaccount itself, so it cannot reach a second position in one market |
| Cancel isolated orders, add margin      | Rise's resolved builders, with its collateral sweeps                                    |
| SOL deposit                             | Rise `buildNativeSolDepositFlow`. If its RPC client cannot use ours, the same three Rise builders in the same order |
| SOL withdrawal                          | Rise `buildWithdrawNativeSolIx`                                                         |
| Everything cross that works today       | Unchanged                                                                               |

When opening, Phoenix's server picks the subaccount, registers it and orders the steps. We do not repeat that logic, so `allocateIsolatedSubaccount` and Rise's flows stay out of our code.

We use only Rise's HTTP client (`PhoenixHttpClient`), which needs no RPC or streams and uses the Worker's `fetch`. `rise.ts` wraps it, so tests fake that wrapper.

### 3.2 We verify what the server returns

An embedded wallet signs without further approval, so the server's answer is treated as untrusted until checked. A failed check is an error, never a warning, and nothing is simulated or signed.

`checkPhoenixBundle` decodes every instruction with Rise's decoders and requires:

- **Known instructions only.** Each one is on a list of the kinds in section 2. Anything else is refused.
- **The wallet's own accounts.** Every trader account is a PDA of this wallet, derived locally.
- **Only the wallet signs,** and only allowed programs appear (the existing `checkInstructions`).
- **The order is what we asked for:** side, size, price limit, minimum fill and reduce-only. The price limit is never null.
- **Collateral is exact:** the transfer equals the amount asked, from cross to the subaccount.
- **Triggers are exact:** direction, price, worst price and size.
- **Close means close:** a close's bundle moves no collateral out of cross.
- **SOL deposits:** the System transfer goes to this wallet's trader account for exactly the amount.

We do not check exact instruction order or count, because the server changes those by account state. The simulation still runs on every transaction.

Tests use real responses saved from Phoenix as fixtures, plus tampered copies that must be refused.

### 3.3 Atomic by default

An isolated order with TP/SL is one transaction. If any step fails, nothing happens, so a filled order cannot land without its TP/SL.

### 3.4 Expiry

Phoenix's server sets no slot expiry on the order, so isolated opens have no `expiresAfterSlot`. The blockhash limits their life, and the required price limit still bounds the fill.

### 3.5 Fills

Same as cross: a required price limit and partial fills down to one lot (**D4**), passed as `maxPriceInTicks` and `minBaseLotsToFill`.

### 3.6 SOL collateral

- `phoenix_deposit` reads `/v1/collateral/assets` and the trader's `maxBalance`, then sizes against `nativeSolCollateralHeadroomLamports`. An amount over the headroom is refused, so no SOL lands uncounted.
- It also refuses when Phoenix marks SOL inactive.
- SOL withdrawals use `withoutExcess`, so they never touch lamports Phoenix has not counted.
- We show SOL's margin value at Phoenix's current discount. We do not assume 80% stays fixed.

## 4. Tools

All take `wallet`, as today. `subaccount` always comes from `phoenix_get_account`. Every new amount is explicit, with no default.

| Tool                                | Change                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `phoenix_market_order`              | Adds `marginMode` (`cross` default, or `isolated`), `collateralUsdc?`, `collateralSol?`, `takeProfit?`, `stopLoss?` (full position only)     |
| `phoenix_limit_order`               | Adds `marginMode`, `collateralUsdc?`, `collateralSol?`                                                                                       |
| `phoenix_close_position`            | Adds `subaccount?`. Without it, closes the only position in that market, or returns an error listing the subaccounts if there are two        |
| `phoenix_cancel_orders`             | Adds `subaccount?`, as above. Sweeps collateral back when the subaccount ends up empty                                                       |
| `phoenix_deposit`, `phoenix_withdraw` | Add `asset` (`USDC` default, or `SOL`)                                                                                                     |
| `phoenix_set_tpsl` (new)            | `symbol`, `subaccount?`, `takeProfit?`, `stopLoss?`, and one of `percent` (1–100) or `size` (tokens, at most the position)                   |
| `phoenix_cancel_tpsl` (new)         | `symbol`, `subaccount?`, `leg` (`takeProfit`, `stopLoss` or `both`), `slot?`. Without `slot`, cancels every active one on that leg           |
| `phoenix_add_isolated_margin` (new) | `symbol`, `subaccount?`, `amount` (USDC)                                                                                                     |
| `phoenix_get_account`               | Each position gains `takeProfit` and `stopLoss`, each a list with trigger, worst price, size and `triggerId`                                 |

`takeProfit` and `stopLoss` are `{ triggerPrice, worstPrice }`. Both prices are required (**D5**). A trigger on the wrong side of mark is refused.

Isolated orders that open a position need at least one of `collateralUsdc` or `collateralSol`.

**Errors for agents**

- A cross order on an isolated-only market: "GOLD trades only in isolated margin; set marginMode to isolated and give collateral". We never switch modes silently.
- Not enough cross collateral: `insufficient_funds`, naming `phoenix_deposit`.
- An isolated order on a market with a cross position is refused (**D2**).

**Always shown in the review**

- Isolated: "Losses are limited to this position's collateral, and it can be liquidated while your cross account still holds funds."
- TP/SL: trigger, worst price and size; that triggers use mark price; that a stop may not fill past its worst price; that a flip cancels them.
- SOL collateral: its value moves with SOL, only part of it counts toward margin, Phoenix may convert some to USDC if your USDC balance goes negative, and it does not raise your USDC withdrawal limit.
- First use: the one-time rent, in SOL.

## 5. Phases

One small PR per phase (**D10**), and a stop for your approval after each.

Each phase carries its own review text, ledger labels and tests. Phases 1–6 use unit tests and mainnet simulation only; nothing is signed until Phase 7.

Prod deploys are not gated, so a merged tool reaches agents right away. Phase 1 is read-only and merges when approved. The PRs for phases 2–6 stack on each other, get reviewed one at a time, and merge in order only after Phase 7 passes.

### Phase 0: sign-off

- **Done 2026-11-01.** Phoenix's open questions are answered from its docs and the web where possible; the live run settles the rest, so they block nothing.

### Phase 1: read TP/SL

- **Build:** the trigger fields in `schemas.ts`; `takeProfit` / `stopLoss` in `phoenix_get_account` and `readPhoenixAccount`.
- **Test:** a position with each kind of trigger, and with none.
- **Verify:** a real wallet with TP/SL confirms the live shape. If we find none, Phase 7 does this, and `phoenix_cancel_tpsl` is confirmed there.
- **Exit:** agents can see protection set anywhere, including in Phoenix's own app.

### Phase 2: open isolated positions

- **Build:** the Rise HTTP client in `rise.ts`, `checkPhoenixBundle`, `marginMode` and USDC collateral on market and limit orders. Remove the isolated-only refusal.
- **Also:** `operation.ts` review text, which still says "cross-margin account"; `PerpTrade` gains `marginMode` and `collateralUsdc`; `trades.ts` labels.
- **Test:** saved Phoenix responses, every tampered case, cross position present, low collateral, new and reused subaccounts.
- **Verify:** simulate market and limit orders on an isolated-only market and a normal one.
- **Exit:** the 13 markets open in simulation.

### Phase 3: manage isolated positions

- **Build:** `subaccount` on close and cancel, `phoenix_add_isolated_margin`, sweeps.
- **Also:** the MCP tool count test; `positionSize` reads the right subaccount.
- **Test:** cross and isolated in one market, ambiguous requests, sweep only when empty.
- **Exit:** an isolated position can be run start to finish in simulation.

### Phase 4: TP/SL

- **Build:** `phoenix_set_tpsl`, `phoenix_cancel_tpsl`, TP/SL on `phoenix_market_order`, trigger checks.
- **Also:** `PerpTrade` gains `set_tpsl`, `cancel_tpsl`, `takeProfitPrice`, `stopLossPrice`.
- **Test:** long and short, full and partial, wrong-side triggers, size over the position, each cancel leg.
- **Verify:** explain the AMZN failure; simulate cross market order plus TP/SL. If that cannot be one transaction, tell you before continuing.
- **Exit:** every TP/SL path is checked and simulated.

### Phase 5: SOL collateral

- **Build:** `asset` on deposit and withdraw, `collateralSol` on isolated orders, the System program for the deposit tool only, headroom and active checks, SOL margin value in `phoenix_get_account`.
- **Test:** over headroom, inactive asset, wrong destination, too little SOL for fees.
- **Exit:** SOL works from deposit to withdrawal in simulation.

### Phase 6: dashboard and docs

- **Build:** TP/SL column on positions and TP/SL lines on the chart (**D9**), consent text if needed, script commands, READMEs and `SKILL.md`.
- **Test:** the dashboard's existing perps tests, with TP/SL fixtures.
- **Exit:** everything is ready for the live run.

### Phase 7: live run

Only when you say go, with your typed `yes` at each step. The budget is 10 USD in total (**D11**). Every step uses the smallest size that works: 0.001 GOLD is about $3.90 notional, and 0.01 SOL about $0.95.

1. Deposit USDC into cross.
2. Isolated market order on GOLD with TP and SL, funded by USDC. Read the account.
3. Add margin. Cancel the TP, then set a new one.
4. Close, and confirm the collateral is back in cross.
5. Isolated limit order far from mark. Cancel it, and confirm the collateral is back.
6. Cross market order on SOL with TP and SL. Cancel them, set a partial TP, cancel it, close.
7. Deposit SOL. Open an isolated GOLD position with it, close, withdraw the SOL.
8. **One real trigger.** Isolated GOLD position with a stop very close to mark. Wait for it to fire, or close by hand if it does not, and record the delay.
9. **One real partial trigger.** A position of a few lots with a 50% stop very close to mark, to learn whether it closes half or all of it.
10. Withdraw what is left.

- **Record:** signatures, costs and the trigger's delay go here. No screenshots.
- **Exit:** the PRs for phases 2–6 merge in order, and the spec is marked built.
- **If a step fails:** we stop, fix it in that phase's PR, and rerun that step.

## 6. Decisions

| #   | Question                            | Decided                                                                                       |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| D1  | Where instructions come from        | Phoenix's server routes through Rise's client, plus Rise's builders where no route exists      |
| D2  | Cross and isolated in one market    | Refused                                                                                       |
| D3  | Sizing isolated positions           | Explicit size and collateral                                                                  |
| D4  | Partial fills on isolated orders    | Allowed                                                                                       |
| D5  | TP/SL worst price                   | Required, no default                                                                          |
| D6  | Partial TP/SL                       | Supported, by percent or size, through `phoenix_set_tpsl`                                     |
| D7  | TP/SL on resting limit orders       | Later                                                                                         |
| D8  | Add margin tool                     | Included                                                                                      |
| D9  | Dashboard TP/SL                     | A column plus chart lines                                                                     |
| D10 | PRs                                 | One small PR per phase                                                                        |
| D11 | Live runs                           | One run at the end, 10 USD in total, about 6 USDC and 4 USD of SOL                            |

**Funding the run.** The wallet must hold about 0.042 SOL and 6 USDC. It needs SOL because it pays its own fees and rent. About 0.02 SOL goes to rent, which should be treated as spent, and 0.01 SOL is the collateral test.

## 7. Open questions

Researched 2026-11-01 from Phoenix's docs, its OpenAPI file, Rise and the `rise-public` repo. No source answers the parts marked unknown; the live run covers them.

- **Q1. Who fires TP/SL?** A permissioned Phoenix keeper. The program has `PingConditionalOrders` and `ExecuteConditionalOrder`, whose signer needs a STOP_LOSS permission, and Rise's own tests run them as a keeper. **Unknown:** the delay after mark crosses. Phase 7 measures one.
- **Q2. What if a stop misses its worst price?** An IOC stop is immediate-or-cancel and all-or-none, so it cancels instead of resting; a limit-kind trigger rests. **Unknown:** whether the keeper tries again.
- **Q3. Does rent come back?** No path found. No instruction closes a conditional orders account or a trader account, and cancelling leaves the account in place. Treat the rent as spent.
- **Q4. Will the `/v1/ix/*` routes stay open without login?** Not stated. OpenAPI marks them Bearer, but it also marks public reads that way, and Rise treats auth as optional. If they close, we add Rise's `auth` option; every call would then need a wallet login first.
- **Q5. How does a cancel find its trigger?** `conditionalStopLossId` is not the index. The index is a slot in the on-chain conditional orders account, 1–191, which Rise's cancel example reads with `activeOrderIndices`. One slot holds a greater and a less leg, chosen by `executionDirection`.
- **Q6. Partial TP/SL at fire time.** **Unknown:** how a percent behaves after a position shrinks, and what caused the AMZN `InvalidInstructionData`. Docs only cover the full-position case.

## 8. Risks

- **We depend on Phoenix's server.** If it is down, isolated and TP/SL tools fail; nothing partial happens. Checks in 3.2 stop a wrong answer from being signed.
- **A check can be too strict.** If Phoenix adds a new instruction, the tools refuse until we add it to the list. That is the safe way to fail.
- **A stop is not a guarantee.** It depends on Phoenix firing it and on the book at that moment. The product must never call a position "protected" without that caveat.
- **Partial TP/SL.** We have only seen it place, not fire. Phoenix's docs describe only full closes, so a 50% TP might close everything. Reviews warn about this until Phase 7 settles it.
- **Stale TP/SL.** Phoenix cancels triggers when a position flips, so agents should read the account before relying on them.
- **SOL price.** A falling SOL price lowers margin on its own, and can trigger conversion to USDC or liquidation.
- **Rise is 0.x.** The version stays pinned. Upgrading reruns the simulations.
