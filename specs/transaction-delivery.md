# Transaction delivery: tech spec

Status: Phases 0 and 1 built 2026-10-09. Phase 2 in progress.

## 1. Goal

An agent calls the real transaction tool (a swap, a transfer) and picks how it
is signed and sent:

| `delivery` | Who signs                                  | Who sends                        |
| ---------- | ------------------------------------------ | -------------------------------- |
| `link`     | The user's browser wallet on the review page | LanaTools                      |
| `local`    | The agent's own wallet                     | LanaTools, via `send_transaction` |
| `embedded` | The user's LanaTools wallet, no approval   | LanaTools                        |

Every transaction tool returns the same result shape in every mode, and the
agent can read the outcome with `get_transaction_status`.

## 2. Decisions

| #   | Decision                                   | Choice                                                                                     |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Who picks the mode                         | The agent, through `delivery` on the tool call                                              |
| 2   | Tool surface                               | One MCP tool per operation, each with `delivery`; `create_transaction_link` is removed       |
| 3   | Embedded approval                          | None. The server signs when the agent asks                                                  |
| 6   | Embedded limits                            | None for now. No amount rules on swaps or transfers                                          |
| 7   | Jupiter permission                         | The one Jupiter permission covers data and swaps. The stored scope stays `jupiter:read` so existing connections keep working; only the consent text changes |
| 8 | SOL transfer permission | New `solana:transfer` permission gates `solana_transfer` |
| 9 | Signing key storage | Worker secret for now, as the payment key is. Move both keys to a KMS with rotation before public launch |
| 4   | Phoenix                                    | After swap and transfer. Phoenix tools must return the shared result shape (§4)              |
| 5   | Swap tool                                  | `jupiter_build_swap` becomes `jupiter_swap` and always uses the link builder rules (no JupiterZ, single signer, wallet pays fees) |

## 3. Today (facts this spec relies on)

- `TransactionOperation` (`packages/toolkit/src/transactions.ts`) already has
  `arguments`, `describe`, `build`, `relay`. Only the link path uses it.
- `BuilderContext` requires `linkId`; `solana_transfer` writes it into its memo.
- `jupiter_build_swap` builds through `buildSwap` without `excludeRfq`, so it can
  return JupiterZ routes that only Jupiter's execute endpoint can send. No MCP
  tool sends them.
- `create_transaction_link` has no scope, so any grant can create a swap link.
- `transactionLinkStatus` exists but no MCP tool calls it.
- The embedded signer's Privy policy allows only Compute Budget, Memo and USDC
  `TransferChecked`. One server key signs for every user. Limits count USDC only.

## 4. Shared result shape

Every transaction tool, `send_transaction` and `get_transaction_status` return:

```ts
TransactionResult = {
  id: string
  tool: string
  network: 'mainnet' | 'devnet'
  delivery: 'link' | 'local' | 'embedded'
  status: TransactionStatus        // the former TransactionLinkStatus
  review: TransactionReview
  reviewUrl?: string               // link only
  transaction?: PreparedTransaction // local, while ready to sign
  signature: string | null
  receipt: TransactionReceipt | null
  expiresAt: number
}
```

`transaction?: PreparedTransaction` is set for a local request that is ready
to sign.

## 5. Phases

Each phase ends with review and approval before the next starts.

### Phase 0: one transaction core, link mode only

No new delivery modes yet. The agent-facing change is the new per-tool surface.

1. **Storage.** Migration renames `transaction_link` to `transaction_request`
   and adds `delivery` (default `link`). The `/tx/:id` URL and page stay.
2. **Context.** `BuilderContext.linkId` becomes `requestId`. The SOL memo
   becomes `lanatools:<requestId>`.
3. **Tools.** Register `solana_transfer` and `jupiter_swap` in MCP from
   `transactionTools`. Input = the operation's own `arguments` plus `delivery`
   (only `link` accepted in this phase) and `idempotencyKey`. Plain object
   schemas, no top-level union. `wallet` arrives with local delivery.
4. **Scopes.** `jupiter_swap` needs `jupiter:read`. `solana_transfer` needs
   the new `solana:transfer` permission, added to `TOOL_SCOPES` and the consent screen.
5. **Status.** Add `get_transaction_status {id}` on the existing
   `transactionLinkStatus`, returning `TransactionResult`.
6. **Remove** `create_transaction_link` and `jupiter_build_swap`. Update
   `apps/mcp/README.md` and `apps/api/src/transactions/README.md`.

Verify: unit tests for each tool's input, scope and result shape; a mainnet
1 USDC to SOL link and a small SOL transfer link end to end; `bun run check`.

### Phase 1: local mode

- `delivery: 'local'` requires `wallet`. The server reserves and builds at once
  and returns `transaction` (unsigned) in the result.
- The public `/api/transaction-links/:id` routes must refuse rows whose
  `delivery` is not `link`, so a visitor cannot prepare or send them.
- New `send_transaction {id, transaction}` runs the same checks as the link
  send path (exact message bytes, single signer = `wallet`, blockhash valid)
  and relays with the operation's own `relay` (RPC or Jupiter execute).
- Expired before signing: the agent calls the tool again with a new key.

### Phase 2: embedded mode (server signs, no approval)

Starts with the Privy proof in §6.

- A second Privy key quorum, "LanaTools transactions", separate from the
  payment signer. The payment signer and its USDC-only policy do not change.
- Its policy allows programs, not amounts: System, Token, Associated Token,
  Compute Budget, Memo and the Jupiter program. No address or amount rules.
- Signer setup (`signer-setup.ts`, `payment-signer.ts`, `payment_signer`) must
  handle two signers on one wallet. Today confirm expects exactly one, and the
  browser fallback removes every signer.
- The signature is stored before sending, as payments do today. Send with the
  operation's `relay`.

### Phase 3: Phoenix

Wrap the six single-signer trade tools as `TransactionOperation`s that return
`TransactionResult`. Activation (co-signer plus login message) comes last.

## 6. Privy findings (2026-10-09)

- **Key setup.** Privy recommends separate keys for separate jobs, keys held in
  a hardware-backed KMS, rotation every 90 to 180 days, and different keys on
  different wallets to limit the blast radius. The user owns the wallet and
  our key is only an added signer, so our server cannot change the user's
  policies. That already matches Privy's split between management and
  signing keys.
  ([security checklist](https://docs.privy.io/security/implementation-guide/security-checklist),
  [server signers](https://docs.privy.io/recipes/wallets/user-and-server-signers))
- **Policies and swaps.** Policies check top-level instructions. Program IDs
  are always in a transaction's static keys, so a program allowlist can work
  for Jupiter swaps. Privy cannot read addresses stored in lookup tables, so
  address rules (recipients, accounts) would reject swaps. Privy's Solana
  examples allowlist the Jupiter program.
  ([Solana policy examples](https://docs.privy.io/controls/policies/example-policies/solana))
- **Not yet proven.** That a real `/swap/v2` transaction passes a
  program-only policy. Proof: attach a test signer with that policy to a
  mainnet wallet, build a real swap, call Privy `signTransaction` and never
  send it. Signing alone moves no funds.
