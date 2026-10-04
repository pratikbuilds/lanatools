# Transaction history and Parsed Events

`get_transaction_history` accepts `address`, optional inclusive ISO `since` /
`until` timestamps (UTC `Z` or an explicit offset), `status` (`any`, `succeeded`,
`failed`), `limit` (default 10, 1–100), and an opaque `cursor`.

Results are newest-first `transactions` with signature, time, status, exact
`fee_sol`, `net_balance_changes`, and `next_cursor`. SOL and token quantities
are decimal strings. Type and description are null on devnet.

Pass `next_cursor` back with **the same inputs** until it is null. Do not derive
cursors from signatures or slots. The provider's pagination token is preserved
exactly inside an HMAC-authenticated envelope bound to the tool, query, and
platform RPC URL. It survives new worker instances. Modified, unissued,
cross-query, cross-network, or different-credential cursors return
`invalid_input` before an upstream request. Rotating the RPC URL/key intentionally
invalidates existing cursors. No URL or API key is stored in the cursor payload.
The cursor is an opaque API token, not encrypted data.

Devnet uses `getTransactionsForAddress` with full `jsonParsed` transaction data,
version 0 support, descending order, status filters, and whole-second block-time
bounds. Fractional ISO bounds round inward to preserve inclusive comparisons.
Net SOL deltas include fees and rent. Token deltas compare raw pre/post balances.
If either token-balance array is unavailable, `net_balance_changes.tokens` is
null while known SOL deltas remain available. Empty token deltas require both
arrays to be present; missing metadata is never treated as a zero token balance.
Malformed non-array token metadata returns `upstream_error`.

For the exact `mainnet.helius-rpc.com` RPC host, both transaction tools POST to
`/v1/parsed-events/transactions` or `/v1/parsed-events/transaction-history`, using
the existing RPC query parameters. They do not use legacy Enhanced Transactions
URLs or infer mainnet from arbitrary provider names. Both request raw transactions.
History `status` filtering is local because the Parsed Events request schema does
not accept it. Therefore a filtered page may be empty and still have a non-null
`next_cursor`; continue paging. `limit` bounds the fetched page, not the filtered
count. A parser failure has unknown status and is excluded from status-filtered
pages, while an `any` query preserves its sanitized item-level error.

Parsed Events supplies lower-case summary types (for example `swap`), descriptions,
and decoded instructions (included only for `detail: "full"`). Its execution
`transactionStatus: "ERROR"` means failed even when `parserStatus` is `OK`.
Only `parserError.code: "transaction_not_found"` means `found: false`; other parser
errors produce `found: null`, `status: "unknown"` and a sanitized `parser_error`.
Raw pre/post balances provide exact net changes. Transfers alone cannot reconstruct
fees, rent, or Token-2022 deductions, so missing raw balance data produces null
net changes rather than invented deltas.

## Validation and fixture provenance

Offline tests cover more than 10 devnet transactions, exact provider continuation
boundaries, cursor restart/forgery/query binding, ISO validation, bigint balances,
lookup-table addresses, mainnet body/URL contracts, missing transactions, parser
and execution errors, and an empty locally filtered page followed by another page.

`src/fixtures/parsed-events-synthetic.ts` is explicitly synthetic, based on the
published response schema reviewed on 2026-10-03. It is **not a recording of a live
mainnet response**. No live Helius credentials were available for recording; a
credentialed mainnet smoke test and genuine recorded fixtures remain an external
verification step. Do not relabel these fixtures as recorded data.

Official references:

- https://www.helius.dev/docs/rpc/gettransactionsforaddress
- https://www.helius.dev/docs/parsed-events/quickstart
- https://www.helius.dev/docs/parsed-events/parsed-response
- https://www.helius.dev/docs/api-reference/parsed-events/transaction-history
