# Dashboard: Transactions tab

Status, October 10, 2026: P0 mockup at
[mockups/dashboard-transactions.html](mockups/dashboard-transactions.html)
approved (card surface). P1, P2 and P3 built and checked with unit tests,
fakes and a mocked browser run; the devnet gates (real swaps, transfers,
withdrawals and deposits) are not yet run. Builds on
[dashboard-activity.md](dashboard-activity.md) and
[transaction-delivery.md](transaction-delivery.md).

## 1. Goal

A signed-in user can see every on-chain movement that involves their
LanaTools wallet or that an agent prepared through LanaTools, from one tab:

1. **Agent transactions**: swaps and SOL transfers an agent prepared with a
   transaction tool, in any delivery mode, with their status and signature.
2. **Withdrawals**: transfers the user sent from the Wallet page.
3. **Deposits**: SOL and tokens that arrived in the wallet.

Each row opens a drawer with the details and the signature. The list can be
filtered by status, kind, client, signing method and address.

## 2. Today (facts this spec relies on)

- The Activity feed (`apps/api/src/payments/activity.ts`) reads only
  `payment_activity` and `tool_activity`.
- Transaction tools (`jupiter_swap`, `solana_transfer`, `send_transaction`,
  `get_transaction_status`) are registered in `apps/mcp/src/server.ts`
  separately from `registerTools`, so they never pass through `callTool` and
  never write a `tool_activity` row. Their state lives in
  `transaction_request`, which no dashboard route reads.
- `transaction_request` stores: tool name, arguments JSON, network, creator
  user, client and grant, delivery, status, revision, `account` (the signing
  wallet, set at creation for embedded and at prepare time for link and
  local), `review_json`, `candidate_json`, signature, `receipt_json`, error
  code and timestamps. Its only index is the idempotency unique index on
  (creator user, creator client, key). There is no per-user time index.
- A row's status moves forward only when something reads it:
  `observeTransactionLink` runs on the review page's GET, on
  `get_transaction_status`, and after a send. A row whose sender never polled
  can stay at `submitting` or `unknown` indefinitely.
- Withdrawals (`apps/api/src/routes/wallet-withdrawals.ts`) prepare and send
  but record nothing. `sendWithdrawal` returns `{signature, confirmed}`.
- Deposits are not recorded anywhere. The Deposit drawer only shows the
  address.
- `apps/api/src/payments/settlement.ts` already walks the wallet's history
  with `getSignaturesForAddress`, so the RPC pattern exists in the API.
- `packages/helius/src/transactions.ts` has `netBalanceChanges` and
  `transactionSummary` for parsed transactions, but `index.ts` does not export
  them.
- Paid x402 and MPP calls also move USDC out of the wallet, and are already
  shown in Activity with their signature.

## 3. Decisions

| #   | Decision                           | Choice                                                                                                                                                                                             |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where transactions appear          | A new **Transactions** destination in the dashboard nav (Wallet, Activity, Transactions, Settings). Activity is unchanged.                                                                         |
| 2   | Totals                             | None. No spent, count or chart on this tab.                                                                                                                                                        |
| 3   | What a row is                      | One of three kinds: `agent` (a `transaction_request`), `withdrawal`, `deposit`. Withdrawals and deposits are `wallet_transfer` rows.                                                               |
| 4   | How withdrawals are recorded       | The `/send` route inserts a `wallet_transfer` row before it relays, with the signature it has already computed. Status `pending` until confirmed, as agent rows already work.                     |
| 5   | How deposits are recorded          | Synced from chain on read, not by a cron job. Opening the tab asks the API to fetch the wallet's signatures newer than the last stored one and insert incoming transfers. See §5.3.                 |
| 6   | Duplicates                         | A chain-synced transfer whose signature already exists in `transaction_request`, `wallet_transfer` or `payment_activity` is skipped. Agent and payment rows own their signatures.                  |
| 7   | Payments in this tab               | Not shown. They stay in Activity. Decided October 10.                                                                                                                                              |
| 8   | Status groups shown to the user    | **Pending** (`open`, `preparing`, `ready`, `submitting`, `unknown`), **Confirmed**, **Failed** (`failed`), **Expired** (`expired`, `transaction_expired`). The raw status is shown in the drawer. |
| 9   | Freshness                          | The list shows stored status. Opening a pending agent row's drawer re-observes that one row through `GET /api/transactions/:id`, polling every five seconds while it stays pending. No RPC calls on list reads. |
| 10  | Address filter                     | One free-text address filter. For agent rows it matches the signing wallet and, for transfers, the recipient. For wallet rows it matches the counterparty.                                        |
| 11  | Counterparty storage               | `transaction_request` gains a nullable `counterparty` column, written at creation for `solana_transfer` (the recipient). Swaps leave it null. Needed so the address filter is an indexed query.    |
| 12  | What the drawer shows              | The stored review (title and fields), kind, client, signing method, status, signature with copy and Explorer link, receipt slot and commitment, error code, and the review URL while a link is open. |
| 13  | What is never returned             | `arguments_json`, `candidate_json`, execution metadata, grant IDs, idempotency keys.                                                                                                              |
| 14  | Design rules                       | As in dashboard-activity.md: no icons in rows, serious, one focal point, row opens a drawer. Confirmed is the quiet default, as on Mercury's Transactions page; only exceptions get a small mark beside the title. Lime marks money that arrived (a deposit's amount), coral marks failed, pending is outlined, expired is muted. The first round, with boxed segment controls and six columns, was rejected as heavy. |
| 18  | Row hierarchy                      | What moved and how much first, then with whom, then who started it. Five columns: Time, Transaction, Source, Amount, Signature. Status is not a column. Client and signing method share the Source column as "Codex · Embedded"; withdrawals read "You · Wallet page"; deposits have no source. |
| 20  | Ledger surface                     | One bordered card with a tinted header row, as the Connected clients table; amounts set a size up with the unit small and mute; a Klein blue rail on hover. Open hairlines were tried and read as dull. |
| 21  | Signature in the row               | Rows that reached the chain show the shortened signature as an Explorer link, so a done transaction can be verified without opening the drawer. |
| 22  | Sync batch                         | One call fetches at most 25 unknown transactions, oldest first, and answers `more: true` when it stopped early; the page calls again until `more` is false. 25 keeps a call inside the Workers free-plan budget of 50 subrequests and to a few seconds. The bookmark is the newest row the sync itself inserted, never a withdrawal the Wallet page recorded. |
| 19  | Filter band                        | Status is a row of plain text tabs with counts, since it is what people scan for. Kind, client and signing are quiet selects, and the address search sits beside them. No boxed segment controls. |
| 15  | Amounts                            | Signed from the wallet's side: out is negative, in is positive. A swap shows what it paid, with what it received on a second line. Failed and expired amounts are struck through, since nothing moved. |
| 16  | Second line of a row               | Answers "with whom": "To <addr>" for transfers and withdrawals, "From <addr>" for deposits, "Jupiter" for swaps, and the failure reason in coral for failed rows. Addresses are shortened in rows and full in the drawer. |
| 17  | Deposit counterparty               | The other owner in the transfer when there is exactly one, otherwise the fee payer. Decided October 10.                                                                                            |

## 4. API

### 4.1 `GET /api/transactions`

Privy auth. Query, all optional: `kind` (`agent` | `withdrawal` | `deposit`),
`status` (`pending` | `confirmed` | `failed` | `expired`), `client`,
`delivery` (`link` | `local` | `embedded`), `address`, `before` (cursor).
Returns `{ items, nextCursor }`, newest first, 50 per page, with the same
`(createdAt, id, kind)` cursor shape Activity uses.

```ts
TransactionActivityItem =
  | {
      kind: 'agent'
      id: string
      tool: string                 // 'jupiter_swap' | 'solana_transfer' | ...
      delivery: 'link' | 'local' | 'embedded'
      status: TransactionStatus    // raw, grouped in the UI
      network: 'mainnet' | 'devnet'
      clientId: string
      clientName: string | null
      connected: boolean
      review: TransactionReview
      account: string | null       // signing wallet
      counterparty: string | null
      signature: string | null
      receipt: TransactionReceipt | null
      reviewUrl: string | null     // link delivery, while open
      reason: string | null        // error code
      createdAt: number
      expiresAt: number
    }
  | {
      kind: 'withdrawal' | 'deposit'
      id: string
      status: 'pending' | 'confirmed' | 'failed'
      network: 'mainnet' | 'devnet'
      mint: string | 'native'
      symbol: string | null
      decimals: number
      amountAtomic: string
      counterparty: string
      signature: string
      slot: string | null
      createdAt: number            // block time for deposits, send time for withdrawals
    }
```

The query merges two bounded reads (one per table) the way `listActivity`
merges payments and tools: each read fetches one page plus a sentinel, the
rows are merged in memory, and the cursor carries the kind as a tie-breaker.

### 4.2 `POST /api/transactions/sync`

Privy auth. Runs the chain sync in §5.3 for the signed-in user's wallet and
returns `{ inserted, settled, more }`. The web calls it when the tab mounts
and whenever the window regains focus, calls again while `more` is true, and
refetches the list when either count is above zero. Idempotent; concurrent calls are safe because inserts are
keyed on signature, mint and direction. An RPC failure is a 502 without the
provider's message.

### 4.3 `GET /api/transactions/:id`

Privy auth. Returns one of the user's transactions as the list item shape.
For an agent request that was sent, it first re-observes the chain through
`observeTransactionLink` and persists the result, so the drawer can refresh a
pending row. The public link route could not serve this, since it answers
only for link delivery; local and embedded requests are never public.

## 5. Data

### 5.1 Migration 0017

```sql
ALTER TABLE transaction_request ADD counterparty text;
CREATE INDEX transaction_request_user_time
  ON transaction_request (creator_user_id, created_at, id);
CREATE INDEX transaction_request_user_account
  ON transaction_request (creator_user_id, account);
CREATE INDEX transaction_request_user_counterparty
  ON transaction_request (creator_user_id, counterparty);

CREATE TABLE wallet_transfer (
  id text PRIMARY KEY,
  privy_user_id text NOT NULL,
  wallet text NOT NULL,
  direction text NOT NULL,            -- 'in' | 'out'
  network text NOT NULL,
  mint text NOT NULL,                 -- mint address or 'native'
  symbol text,                        -- display only; null when unknown
  decimals integer NOT NULL,          -- needed to show amount_atomic
  amount_atomic text NOT NULL,        -- u64 as text
  counterparty text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL,               -- 'pending' | 'confirmed' | 'failed'
  slot text,
  block_time integer,
  source text NOT NULL,               -- 'withdrawal' | 'chain_sync'
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX wallet_transfer_signature
  ON wallet_transfer (privy_user_id, signature, mint, direction);
CREATE INDEX wallet_transfer_user_time
  ON wallet_transfer (privy_user_id, created_at, id);
CREATE INDEX wallet_transfer_user_counterparty
  ON wallet_transfer (privy_user_id, counterparty);
```

The unique index includes mint and direction because one transaction can
move several assets (a swap moves two; a transfer can move SOL for rent and a
token). Each asset movement is its own row.

### 5.2 Withdrawal recording

Built. `readSignedWithdrawal` now returns the transfer it checked: mint (or
`native`), amount, decimals, the destination account, and the recipient
wallet when the transaction names it (always for SOL; for a token only when
the transaction creates the recipient's token account). In `/send`, after
the own-wallet check and before `sendWithdrawal`, a `wallet_transfer` row is
inserted with `direction: 'out'`, `source: 'withdrawal'` and
`status: 'pending'`. A token recipient the transaction does not name is read
from the destination token account's owner, and the account itself stands in
if that read fails. After `sendWithdrawal` returns confirmed, the row is
settled; a refusal the cluster gave (`TransferError`) settles it failed; any
other outcome leaves it pending for the chain sync, or for its drawer, which
asks the chain once when opened. If the insert fails, the send still goes
ahead and a fixed diagnostic is logged: a recording failure must not block
the user's money.

### 5.3 Chain sync (deposits, and settling pending rows)

Built in `apps/api/src/transactions/wallet-transfers.ts`, for the wallet in
`payment_signer`:

1. Read the newest `wallet_transfer` row the sync itself inserted
   (`source: 'chain_sync'`) for this wallet; its signature is the bookmark.
   Rows the Wallet page recorded never serve as one: a withdrawal confirmed
   before the first sync would hide every older deposit, and a pending one
   may never land, which would send the RPC through the whole history.
2. Call `getSignaturesForAddress(wallet, { until: bookmark })`, paging with
   `before` in pages of 1000, the RPC's own maximum, until `until` is reached
   or history ends. The first sync for a wallet has no `until` and walks its
   full history.
3. Known signatures are looked up in bulk, then oldest first: a signature
   already in `wallet_transfer` settles any pending row (confirmed, or failed
   from the entry's `err`) and is otherwise left alone; one in
   `transaction_request` or `payment_activity` for this user is skipped; a
   failed transaction is skipped. At most 25 of the rest are fetched with
   `jsonParsed` and `maxSupportedTransactionVersion: 0`, and the wallet's net
   SOL and per-mint token changes become one `in` or `out` row per asset. The
   fee is added back for a wallet that paid it, so an amount is what reached
   the other party. The parser is the API's own; the helius package's
   `netBalanceChanges` stays where it is.
4. The counterparty is the one other account that moved the other way when
   there is exactly one, otherwise the fee payer; the wallet is never its own
   counterparty. Symbols are known for SOL and the network's USDC only; other
   mints show shortened. A row's `createdAt` is the block time, so it sorts
   with everything else by when it happened.

The sync runs inside the request and returns when done. Nothing runs in the
background.

Open question 2 asks how much history one sync may read per call. No cap is
assumed here.

### 5.4 Counterparty on agent rows

`createTransactionRequest` writes `counterparty` when the operation declares
one. Add an optional `counterparty(args)` to `TransactionOperation` in
`packages/toolkit/src/transactions.ts`; `sol-transfer.ts` returns the
recipient, Jupiter returns nothing. Existing rows stay null.

## 6. Web

### 6.1 Navigation

`DESTINATIONS` in `shell.tsx` gains `{ to: '/dashboard/transactions', label:
'Transactions' }` after Activity. New route file
`routes/_account/dashboard/transactions.tsx` keeps the filters in the URL as
Activity does.

### 6.2 List

Grouped by day, same row grammar as Activity. Columns:

| Column      | Agent row                                                                 | Wallet row                                              |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Time        | created                                                                   | block time, or send time while pending                  |
| Transaction | review title ("Swap USDC for SOL") with a status mark when not confirmed; beneath it the recipient, or for a swap "0.0062 SOL received" or "expected" | "Deposit USDC" or "Withdrawal SOL", then "From" or "To" the counterparty |
| Source      | "Codex · Embedded"                                                        | "You · Wallet page" for withdrawals, blank for deposits |
| Amount      | "−1 USDC"                                                                 | "+25 USDC" in lime for a deposit, "−10 USDC" for a withdrawal |
| Signature   | shortened signature linking to Solana Explorer, once the transaction was sent; blank before that | same                             |

Signature is the last column because the row is one button and a link
cannot sit inside a button; the link lives beside it in its own cell.

The signature link opens Explorer in a new tab and does not open the drawer.
Failed and expired amounts are struck through. Failed rows say "Rejected by
the chain. Nothing moved." in coral on the second line. Column headers and
day labels are small uppercase labels in mute, as the dashboard's `d-label`.

On a phone the Source and Signature columns are hidden (the drawer has both) and the title may wrap; the status
tabs scroll sideways rather than wrap.

Filters: a row of status tabs (All, Pending, Confirmed, Failed, Expired)
with counts, then on the right three selects (kind, client, signing method)
and an address search. A "Clear" link appears once any filter is set. Counts
come from the totals the route already computes per status group. Older rows load on scroll. The list refetches every 15
s and on focus, matching the rest of the dashboard; the sync call runs on
mount and focus only.

### 6.3 Drawer

Reuses the dashboard `drawer.tsx` and the signature block from
`activity.tsx` (signature, copy, "View on Solana Explorer"). Top to bottom:
the client and time as the subtitle, the review title, the status group with
the raw status in brackets when they differ, the amount large (struck through
when failed or expired) with the received amount beneath it for a swap, one
sentence on what the status means, then a definition list: the review
fields, counterparty, kind and tool, client, signing method with a short
gloss ("Embedded, no approval"), signer, network, slot and commitment, error
code, and expiry while open. The signature and, for an open link, the review
URL each sit in a well with their own copy and open links. A pending agent
row shows "Checking the chain" and refreshes on open (§4.3).

### 6.4 Wallet page

"Latest activity" on the Wallet page is unchanged. No transactions preview
there in this spec.

## 7. Phases

Each phase ends with a review before the next starts.

**P0: Design.** Drawn October 10: the mockup at
`specs/mockups/dashboard-transactions.html` covers the list, filters, empty
state, and drawers for a confirmed swap, an open link and a failed swap, on
desktop and phone, after studying Mercury's Transactions page. The first
round was rejected as heavy and redrawn around the row hierarchy in decision
18. Gate: mockup approved October 10, card surface.

**P1: Agent transactions.** Built October 10. Migration 0017 (all of it, so
later phases need no second migration), `counterparty` on
`TransactionOperation`, the `transactions` route and contract types, the nav
entry, list, filters and drawer, with the wallet ledger already read so P2
and P3 only write rows. Tests: list pagination, filters and counts with
seeded rows (`apps/api/src/transactions/list.test.ts`), counterparty written
for `solana_transfer`, drawer refresh of a sent row against a fake RPC, no
private fields in responses, rendered rows and drawer
(`apps/web/src/components/dashboard/transactions.test.tsx`), and a browser
run over a mocked API (`tests/e2e/transactions.spec.ts`). Gate: a devnet
swap and a transfer, in each delivery mode, appear with the right status and
signature.

**P2: Withdrawals.** Built October 10: recording in `/send` and settlement
after the relay. Tests: the decoder returns the transfer for SOL and token
withdrawals; a withdrawal is recorded pending once and settled
(`wallet-transfers.test.ts`). The route itself is not unit tested, as it
needs Privy for the own-wallet check. Gate: a devnet USDC and a SOL
withdrawal appear.

**P3: Deposits.** Built October 10: the sync route, deposit rows, settling
of pending withdrawal rows, dedup against agent and payment signatures, and
the page's sync on open and focus. Tests against a fake chain: a SOL and a
USDC deposit are inserted with block time and counterparty, a swap and a
paid call's signatures are skipped, a failed transaction is skipped, a
pending withdrawal is settled, a second sync walks only to the bookmark and
inserts nothing, a later deposit is picked up. Gate: a devnet airdrop and a
USDC transfer into the wallet appear after opening the tab.

**P4: Verification.** `bun run check`, then the full flow on devnet with a
signed-in user, including the address filter against a known recipient.

## 8. Open questions

1. Resolved October 10: one sync call fetches at most 25 unknown
   transactions (decision 22); the page calls again while `more` is true.
2. Should `transaction_request` rows older than the index migration, which
   have no `counterparty`, be backfilled from `arguments_json` in the
   migration, or left null?
