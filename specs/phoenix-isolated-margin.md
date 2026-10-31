# Phoenix isolated margin: tech spec

Status: draft 2026-10-31. Nothing built. Decisions in §3 need approval, and
each phase needs approval before the next starts.

## 1. Goal

An agent can open, manage and close an isolated Phoenix position through
LanaTools, on every delivery path (link, local, embedded), with the same
safety checks as cross-margin trades. A loss on an isolated position is
limited to the collateral given to it.

Customer ask (Oct 31): a no-login tester went 25x long on SOL and asked for
isolated margin.

## 2. Facts this spec relies on

Phoenix (docs read 2026-10-31):

- `subaccount_index = 0` is the cross account. `subaccount_index > 0` is an
  isolated account holding one position, with its own collateral and
  liquidation price.
- Opening takes these steps, in this order: pick a non-zero subaccount;
  register it if new; sync the parent to the child; `TransferCollateral` from
  parent to child; place the order on the child; optionally
  `TransferCollateralChildToParent` to sweep leftovers.
- The sweep only moves collateral when the child has no position and no
  resting orders. A Phoenix crank also sweeps idle children.
- Phoenix refuses an isolated order when a cross position exists in the same
  asset, unless `allowCrossAndIsolatedForAsset` is set.
- `/v1/ix/place-isolated-market-order` and `place-isolated-limit-order` build
  these instructions. The docs say they need a bearer token; they answered
  without one on 2026-10-31.

Measured 2026-10-31 (mainnet simulation, nothing sent):

- Isolated market orders passed for ETH with $10 and GOLD with $20: 6
  instructions, 670 bytes, 266k and 145k compute units. The wallet had no
  isolated account yet.
- 13 of 104 markets are isolated-only: ANTHROPIC, COPPER, ORE, BP, GOLD, SKR,
  WTIOIL, DRV, PONS, ANSEM, STONK, SILVER, METADAO. Today's tools refuse them.

LanaTools today:

- Every trade tool uses subaccount 0: `traderAccountAddress`, `orderContext`
  and `collateralAccounts` in `trade/rise.ts`, and `crossAccount` in
  `trade/tools/shared.ts`.
- `phoenix_get_account` and the dashboard already read isolated positions.
- Only `trade/rise.ts` may import Rise (isolation rule 1 of
  `phoenix-trade-tools.md`).
- Every order is decoded and compared byte for byte with what the tool meant
  to build (`checkOrder`). Nothing unchecked reaches a signature.
- Rise 0.5.38 exports `buildTransferCollateralIxResolved` and
  `buildTransferCollateralChildToParentIxResolved`.

Unknown until Phase 0: see §5.

## 3. Decisions for approval

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | How instructions are built | Locally with Rise, not Phoenix's `/v1/ix/*` | We can decode and byte-compare what we build. Instructions from a server would go to signature on trust, and its token rule may start being enforced |
| 2 | Tool shape | `marginMode: "cross" \| "isolated"` on `phoenix_market_order` and `phoenix_limit_order`, default `isolated` (chosen 2026-10-31) | No new tools to choose between, and a trade risks only its own collateral unless the agent asks for cross. Existing calls change: see §4, Default isolated |
| 3 | Collateral | `collateral` (USDC) required for isolated, no default, refused for cross. An opening order with neither `collateral` nor `marginMode: "cross"` is refused, and the error names both options | The amount sets the trader's maximum loss, so we must not guess it |
| 4 | Isolated-only markets | Cross on these markets stays refused, with an error saying to pass `marginMode: "isolated"` | Clear next step for the agent |
| 5 | Cross and isolated in one asset | Refused, as Phoenix does by default | One position per asset is easier to reason about; can be relaxed later |
| 6 | Closing | `phoenix_close_position` finds the position, cross or isolated, and sweeps the collateral back after a full close. If a symbol has both, not possible under decision 5 | The agent should not need to know subaccounts |
| 7 | Cancelling | `phoenix_cancel_orders` covers every subaccount for that symbol | Same reason |
| 8 | Adding collateral to an open isolated position | New tool `phoenix_add_isolated_collateral` in Phase 4 | An agent needs a way to defend a position from liquidation |
| 9 | Withdrawing | `phoenix_withdraw` stays cross only, and its error says collateral in an isolated position returns after closing | Keeps the withdraw path unchanged |
| 10 | Liquidation estimate before signing | Not in the first version; shown by `phoenix_get_account` after opening | Needs Rise's margin calculator or a Phoenix route; a wrong estimate is worse than none |
| 11 | TP/SL on isolated | Out of scope here, separate spec | Rent, slippage and order limits need their own decisions |

## 4. Design

**Modules.** `rise.ts` gains a subaccount argument on `orderContext` and the
new builders, defaulting nowhere: each caller passes it. `checks.ts` gains
`checkIsolatedOpen`, which requires the exact instruction order from §2,
decodes the transfer, and compares its amount and both subaccounts with the
request. `shared.ts` replaces `crossAccount` with one reader that returns
every subaccount.

**Picking a subaccount.** Reuse the lowest empty isolated subaccount that
already exists, otherwise register the next index, per Phase 0's findings. A
new tool never reuses a child holding a position or resting orders.

**Two prepares at once.** Two prepared opens can pick the same subaccount. The
transaction that lands second must fail rather than add to the first
position. Phase 0 proves how to enforce this; if the program does not, the
prepare fails closed for that wallet while another open is `ready`.

**Contracts.** `PerpTrade` gains optional `marginMode`, `subaccount` and
`collateralUsdc`, so the review page, the dashboard ledger and agents all show
them. The review states the maximum loss in plain words.

**Refusals.** Collateral above the cross account's free balance, zero
collateral, and a same-asset cross position all refuse at prepare time with an
actionable message and no transaction.

**Timing.** Prepared transactions last about 32 seconds, so a local-delivery
isolated open has the same window as any other order. No new expiry logic.

**Default isolated.** Because isolated is the default:

- Orders that omit `marginMode` no longer run as cross. An existing call with
  no `collateral` gets the refusal in decision 3 and no transaction.
- A `reduceOnly` order never opens anything, so it needs no `collateral` and
  acts on the position wherever it is, cross or isolated.
- A wallet with a cross position that wants to add to it must pass
  `marginMode: "cross"`; an isolated order in that asset is refused
  (decision 5), and the error says so.
- The tool descriptions tell the agent to ask the user how much collateral to
  risk, and whether they want isolated or cross, unless the user already said.
  This is guidance only: the refusal in decision 3 is what enforces it.
- Every new position may pay rent for its own account unless an empty child
  can be reused. Phase 0 measures this.

## 5. Phases

### Phase 0: settle the unknowns (no product code)

Answer each with a simulation or a read, and record it here:

- Do `RegisterTrader` and the sync have `Resolved` builders in Rise 0.5.38,
  and do Rise's encoders work with our `@solana/kit`?
- What are the rules for a valid subaccount index, and the maximum?
- Rent for a new isolated account, in SOL.
- Is the rent returned, and can a child be reused after closing?
- Does a transaction whose order lands on an occupied child fail?
- Does the sweep work in the same transaction as a full close?
- Do existing embedded wallet policies allow all of this, or do they need a
  refresh?
- Do isolated limit orders simulate? (Not tested on 2026-10-31.)

Done when: every question has an answer in this file. Any answer that breaks
a decision comes back for approval.

### Phase 1: read every subaccount

Rise builders and `checkIsolatedOpen` with tests, plus the all-subaccount
reader. `crossAccount` callers move to it with no change in behaviour.

Done when: all existing trade tests pass unchanged and the new checks reject a
wrong amount, a wrong subaccount, a wrong order and an extra instruction.

### Phase 2: open isolated

`marginMode` and `collateral` on market and limit orders, the isolated-only
market path, contract fields, and review text.

Done when: tests cover decisions 2 to 5 and §4 Default isolated, the tool
descriptions carry the ask-the-user line, and orders
with `marginMode: "cross"` produce byte-identical transactions to today's.

### Phase 3: close and cancel

`phoenix_close_position` and `phoenix_cancel_orders` across subaccounts, with
the sweep on a full close.

Done when: tests cover partial close, full close with sweep, and cancel on a
child.

### Phase 4: add collateral, then docs

`phoenix_add_isolated_collateral`, then `SKILL.md`, `apps/mcp/README.md` and
the transactions README.

### Phase 5: live test on mainnet

With a wallet and amounts you approve, one real run through each path that
matters: market open, limit open, cancel, add collateral, partial close, full
close with sweep, and withdraw. Then one embedded open and close, and one
link. The same run covers limit orders and cancels, which have never run on
mainnet.

Done when: each transaction is confirmed, the run log is recorded here, and
the collateral is back in the cross account.

## 6. Not in scope

- TP/SL, on cross or isolated.
- Cross and isolated positions in the same asset.
- Isolated controls in the dashboard; it stays read-only.
- SOL as isolated collateral.
- A pre-trade liquidation estimate.
