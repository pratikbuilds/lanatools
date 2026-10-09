# One link tool, shared transaction operations

`create_transaction_link` is the single link-related MCP tool. It references an
existing internal transaction tool and stores its validated intent. It never
builds, signs, or sends during link creation.

```json
{
  "tool": "jupiter_build_swap",
  "arguments": {
    "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "outputMint": "So11111111111111111111111111111111111111112",
    "amount": "1",
    "maxSlippageBps": 50
  },
  "idempotencyKey": "usdc-sol-test-1"
}
```

This requests 1 USDC to SOL with 0.5% maximum slippage. To create another kind of
transaction, change `tool` and `arguments`. A link's stored intent never changes.
Neither network nor wallet belongs in the link arguments. The deployment fixes
the network; the visitor selects a wallet on the page.

## Where each responsibility lives

| Component                               | Responsibility                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/jupiter/src/transaction.ts`   | The existing `jupiterBuildSwapTool` definition, its shared argument schema, review, transaction preparation, and Jupiter execution capability |
| `packages/toolkit/src/transactions.ts`  | Typed transaction capability, provider metadata validation, public candidate projection                                                       |
| `apps/api/src/transactions/tools.ts`    | Bind internal operations to server dependencies and generate the generic link input schema                                                    |
| `apps/api/src/transactions/requests.ts` | Grant, deadline, wallet reservation, signature acceptance, retries and chain confirmation                                                     |
| `apps/mcp/src/server.ts`                | Register one link-creation MCP tool                                                                                                           |

There is no separate `jupiter_swap` tool or link-specific Jupiter implementation
in the API. `jupiter_build_swap` still supports direct unsigned preparation.
Both direct preparation and its shared transaction capability use the same swap
builder. The capability exposes `build` and `relay` independently of link storage
and HTTP routes, so embedded and local signing paths can consume it too. Those
signing paths are not implemented by this link change.

The link path requires a wallet-funded, single-signer transaction whose fee payer
is the selected wallet. JupiterZ RFQ and sponsored routes are excluded/rejected.
Local callers of the existing unsigned tool retain its original behavior and
must handle its returned router/signing requirements.

## Add support for another transaction

1. Give the existing internal tool a transaction capability. Reuse its argument
   schema and builder; define review and submission behavior once in its package.
2. Bind that capability in `transactionOperations` using the existing tool name.

The generic MCP input schema follows the registry automatically. No new MCP tool,
HTTP route, database table, or transaction page is needed. A caller can invoke the
same capability with its own provider dependencies and selected signer. Signing
and lifecycle policy belong to that caller.

The native SOL operation currently lives in `sol-transfer.ts`. It is selected as
`tool: "solana_transfer"` with `recipient` and `amountLamports` arguments, through
the same generic link tool.

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

Status reads remain on the shared HTTP route. The former per-operation link MCP
registrations and `get_transaction_request` MCP registration are removed.

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
