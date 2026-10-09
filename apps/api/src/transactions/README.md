# Transaction tools and shared operations

Each transaction is its own MCP tool. Its input is the operation's own
arguments plus `delivery` and an `idempotencyKey`. A call stores the validated
intent in `transaction_request`; it never builds, signs, or sends.

```json
{
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amount": "1",
  "maxSlippageBps": 50,
  "delivery": "link",
  "idempotencyKey": "usdc-sol-test-1"
}
```

Sent to `jupiter_swap`, this requests 1 USDC to SOL with 0.5% maximum
slippage. A stored intent never changes. Neither network nor wallet belongs in
the arguments: the deployment fixes the network, and for `link` the visitor
selects a wallet on the page. Only `link` delivery exists today; local and
embedded signing are planned in `specs/transaction-delivery.md`.

Every transaction tool and `get_transaction_status` return the same
`TransactionResult` (`packages/contracts`).

## Where each responsibility lives

| Component                               | Responsibility                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/jupiter/src/transaction.ts`   | `jupiterSwapTool`: swap arguments, review, preparation and Jupiter execution                |
| `packages/toolkit/src/transactions.ts`  | Typed transaction operation, provider metadata validation, public candidate projection      |
| `apps/api/src/transactions/tools.ts`    | The transaction tools: scope, title, operation bound to server dependencies, and tool input |
| `apps/api/src/transactions/requests.ts` | Grant and scope, deadline, wallet reservation, signature acceptance, retries, confirmation  |
| `apps/mcp/src/server.ts`                | Register each transaction tool and `get_transaction_status`                                 |

The operation exposes `build` and `relay` independently of storage and HTTP
routes, so local and embedded signing can reuse it.

Swaps require a wallet-funded, single-signer transaction whose fee payer is the
signing wallet. JupiterZ RFQ and sponsored routes are excluded.

## Add support for another transaction

1. Define the operation with `defineTransactionOperation`: argument schema,
   review, builder and submission, once, in its package.
2. Add it to `transactionTools` with its title, description and scope.

The MCP tool and its input schema follow the registry. No HTTP route, database
table, or transaction page is needed. The native SOL operation lives in
`sol-transfer.ts`.

## Link execution

The existing page and routes stay shared:

1. GET `/api/transaction-links/:id` reads review/status without a wallet.
2. POST `/:id/transaction` with `{account}` prepares fresh unsigned bytes on the
   explicit sign action.
3. The wallet signs only. POST `/:id/send` carries the signed payload to the server.
4. The server saves the accepted signature before calling the operation's relay.
   SOL uses the deployment RPC; Jupiter uses `/swap/v2/execute`.
5. RPC chain evidence confirms or fails the accepted signature. The page links to
   the correct Solana Explorer network.

Agents read status with `get_transaction_status`; the page uses the HTTP route.

An operation can return private `execution` metadata. Jupiter saves only its
request ID beside the unsigned candidate in `candidate_json`. The submission
schema validates it before storage and again before signature acceptance. Both
fresh and resumed public responses omit it. Signed bytes and credentials are
never stored there.

The link service preserves its original deadline, one accepted signature, exact
message/signature checks, identical-payload retries and renewal only after
finalized expiry. Provider acknowledgments alone never establish confirmation.

Request keys remain scoped to the user and client across reconnections. Reusing
a key from a previous grant returns a conflict requesting a new key; it never
returns or reassigns the old grant's link. Retries under the same grant still
return the original link.

## Mainnet test boundary

The agreed live test is 1 USDC to SOL with maximum slippage 50 bps.
Set `SOLANA_NETWORK=mainnet` in the root `.env` for the agreed test, with
a mainnet `SOLANA_RPC_URL`, `JUPITER_API_KEY`, isolated local D1 storage, and the
matching `WEB_ORIGIN`. The launcher and local web build read the same root
`SOLANA_NETWORK` setting.
Network labels, token mints, wallet adapter settings and Explorer URLs come from
`packages/contracts/src/networks.ts`. There is no independent frontend
network selector.

The user connects and signs in their wallet. The agreed mainnet swap completed
on October 9, 2026. The saved receipt and an independent RPC status check
confirmed finalization at slot 454798245 with no chain error. Other wallet
and routing combinations remain unverified by this live test.
