# Durable named transactions

This module stores named intent and exact transaction attempts. It has no public
execution route or MCP tool and does not sign, broadcast or call RPC. The first
input contract is `transfer_sol`, with exact positive u64 lamports, an explicit
`embedded` or `external` path and a client-scoped idempotency key.

## One intent survives retries

`createRequest` accepts authenticated `GrantIdentity` and a server-resolved
`RequestContext`. Resolve the embedded wallet from the owner's authoritative
wallet data; never accept its ID or address from an agent. Verify the configured
RPC cluster before preparing. Network verification is the adapter's
responsibility, not a property proved by a stored label.

Normalization fixes field order, converts lamports with BigInt, and stores
versioned canonical JSON plus SHA-256. User/client/key is unique. Same key and
input returns the existing request; changed intent, network or embedded wallet
conflicts. Changing time-sensitive terms requires new intent, not a delayed retry.

An external address may be declared or initially unknown. `selectExternalWallet`
binds once and must match a declared address. Selection never rewrites canonical
input. A later external-link service must verify its own capability before
calling this function; this module checks active client ownership.

`refuseRequest` records a bounded safe reason on an authenticated request with no
possibly executable attempt. It cannot overwrite active transaction progress.
Malformed or unauthenticated arbitrary input is not stored as a trusted request.
Refusals replay under the same key; a changed intent needs a new key.

## Durable writes precede permission

| Operation             | State change                                                            | Returned material                 |
| --------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| `claimPreparation`    | no attempt → preparing                                                  | attempt ID and token, or null     |
| `storePrepared`       | preparing → prepared                                                    | none                              |
| `issueAttempt`        | prepared → issued, external only                                        | exact stored unsigned message     |
| `claimSigning`        | prepared → signing, embedded only                                       | new token and stored message      |
| `storeVerifiedSigned` | signing/issued → signed                                                 | none                              |
| `claimSubmission`     | signed → submitting                                                     | new token and stored signed bytes |
| `recordOutcome`       | submitting → submitted or uncertain; verified chain evidence → terminal | none                              |

Every call must be awaited before exposing bytes or invoking the next side effect.
A failed durable write throws; a failed claim supplies no permit. SQL predicates
check current active user/client/grant identity on each write. Tokens rotate when
signing or submission is claimed, so a repeated or stale claim cannot authorize a
second side effect. A unique partial index also forbids two unresolved attempts.

Adapters supply `PreparedTransaction`: wallet, independently verified network,
final compiled message, preparation slot, blockhash and last-valid block height.
They must validate every instruction, signer role, lookup-table account and
destination before storing it. The ledger checks message signer/blockhash against
metadata, computes the exact byte hash, and checks stored wallet/network. It does
not decide whether instructions implement the named action or satisfy policy.

`storeVerifiedSigned` is only for trusted signing/verification code. The caller
must verify cryptographic signatures first. The ledger additionally decodes the
wire transaction with Kit, checks exact message identity, expected wallet signature
presence and transaction signature. It does not establish cryptographic validity.
Outcome evidence likewise comes from a trusted chain verifier, never agent claims.
RPC acceptance, chain confirmation and finality are distinct. Expiry requires a
height past the stored lifetime and independently checked historical evidence.

## Uncertainty stays unresolved

No claim expires by wall clock. A lost response after a write may mean the write
committed. `getLatestAttempt` lets trusted recovery code read persisted tokens,
bytes, lifetime and evidence after restart. It must reconcile the current step
before acting; retrieving a token alone does not authorize another signing call.
`getRequest` returns only a safe summary for an agent:

```json
{
  "requestId": "request-id",
  "state": "uncertain",
  "attemptId": "attempt-id",
  "signature": "recorded-signature",
  "reason": null
}
```

Only a still-unprepared attempt can be abandoned, allowing the next sequential
attempt. Prepared/issued/signed/submitted/uncertain attempts cannot be replaced.
Failed/expired attempts also remain terminal in this foundation. Live recovery,
byte-identical resubmission and evidence-based replacement belong to the execution
service; they must never re-sign while an older version might execute. Solana's
[submission documentation](https://solana.com/docs/rpc/http/sendtransaction) and
[retry guidance](https://solana.com/developers/cookbook/transactions/retry) explain
why RPC acceptance and elapsed time cannot establish safe replacement.

## Local verification

`bun test apps/api/src/transactions` uses real local D1, applying the generated
migration. Tests cover concurrency, ownership, reconnects, refusal, strict input,
immutable prepared/signed bytes, stale claims, failure before byte release and
restart using a dedicated temporary persisted database. Fixture signatures are
non-cryptographic test bytes. No wallet signing or chain transaction runs.

Payment/read activity and budgets are separate tables and remain unchanged. The
transaction request's originating grant is historical text because reconnecting
replaces the mutable current grant ID. Progress is derived from the latest attempt,
so request and attempt terminal statuses cannot diverge.
