# ADI-175 Privy signing proof

## Result, September 26, 2026

`bun run testbed:privy` created a disposable Privy Solana wallet owned by a synthetic test user, with a server key quorum as an additional signer. The signer had a policy allowing `signTransaction` for System Program transfer instructions of at most 1,000 lamports to one generated recipient. The proof code checked that the transaction contained exactly one intended transfer before asking Privy to sign it. Privy signed without broadcasting; the script sent those bytes to a local Surfpool validator and verified the transaction metadata and both balance changes. A 1,001-lamport request was rejected by Privy with a policy-related API error.

| Evidence | Value |
| --- | --- |
| Surfpool RPC | `http://127.0.0.1:8899`, `surfpool 1.0.0-rc1`, offline mode |
| Privy wallet | `p4182weieuofb549ov0vm69f`, `J5Anc8CU81egkT142XFBSHhNTS99Moa5Ga1AUYa8aUTD` |
| Server quorum | `zq0djo7bw10996kzo5ni6hrf` |
| Signer policy | `v9mtiwcn3hgsqv4tmpaapob6` |
| Recipient | `DVcdvg5cUYmV49Tf99ueKudMf1gUNhqEwczdGic6PHzu` |
| Signature | `2HGxGDauCkq69ZjBQ3JNXuumTSgTFTDuv87nMjFnmQJoDQH7Jr4AfzQxYZGMtsQ6wgAQvJzvmj7F7uEBy4WthaA8` |
| Surfpool result | slot 1257, `meta.err: null`, recipient +1,000 lamports, payer -6,000 lamports including 5,000 fee |
| Final status read | `confirmationStatus: finalized`, `err: null` |
| Guard and policy checks | two 1,000-lamport instructions rejected locally; 1,001-lamport instruction denied by Privy |

Surfpool state is temporary. The transaction signature and local finality do not imply devnet or mainnet settlement. The synthetic user and wallet prove the server signer on a user-owned wallet; they do not prove a real user's login, consent, or revocation UI. Pay Kit and USDC payment are ADI-176.

Privy evaluates Solana policy rules for each instruction, so the 1,000-lamport condition is not a transaction-wide or cumulative spending cap. The proof code rejects a transaction with two 1,000-lamport transfers before it reaches Privy. A production signing path must keep this single-transfer check or enforce a transaction total and a separate cumulative budget.

## Reproduce

Use a dedicated Privy development app. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in an ignored `.env` file. Do not use production credentials. In one terminal run `surfpool start --offline --no-tui --no-studio --no-deploy`. In another run `bun --env-file=.env run testbed:privy`. Each run creates a fresh test user, wallet, quorum, and policy in that Privy app. The P-256 server key exists only in the process and is discarded when it exits. No Solana wallet key or authorization private key is printed or saved.

The script first checks the Surfpool RPC, then creates a 1-of-1 key quorum with a P-256 public key, a narrow Solana policy, and a user-owned wallet with that quorum as an additional signer. It checks that the local single-transfer guard rejects two individually allowed transfers, requests local SOL, signs through Privy, broadcasts through Surfpool, verifies balances and fee, and asks Privy to sign an over-limit transfer. Both the local guard and Privy policy rejection must pass.

## Failure modes seen and checked

- Privy rejects policy and rule names of 50 characters or more. The proof uses short names.
- The Privy Node SDK expects a base64 PKCS#8 authorization key. The proof uses `generateP256KeyPair` from that SDK.
- A signature response alone does not prove execution. The proof checks the signed wire transaction, Surfpool transaction metadata, and balance deltas.
- Two transfer instructions can each satisfy Privy's per-instruction limit. The proof rejects that transaction locally before signing.
- An ordinary API error cannot count as a policy denial. The negative request must return a Privy API error mentioning policy or denial.
- The local validator must be running before the script creates Privy resources. The script checks it first.

Privy documents [server authorization contexts](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server), [additional signers](https://docs.privy.io/wallets/using-wallets/signers/quickstart), [per-instruction Solana policy evaluation](https://docs.privy.io/controls/policies/overview), [Solana policy conditions](https://docs.privy.io/controls/policies/example-policies/solana), and [sign-only Solana transactions](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction). The policy examples use `signAndSendTransaction`; this proof specifically uses `signTransaction` so LanaTools controls the Surfpool broadcast.

## Policy edit authorization follow-up

`bun --env-file=.env run testbed:privy-policy-edit` passed against the development Privy app and local Surfpool on September 26, 2026. It created separate disposable P-256 keys for a simulated user and server. The policy was owned by the user key, while the server key was an additional signer on a synthetic user's wallet. Privy rejected the server key's attempt to increase the rule from 1,000 to 2,000 lamports (HTTP 403). A user-key-authorized increase succeeded and allowed a 1,001-lamport transaction signature; a user-key-authorized decrease to 500 lamports then denied that same signing request. No transaction was broadcast.

This proves the policy edit authorization boundary with separate keys. It does not prove a real user's Privy login, access-token exchange, or a policy-editing UI. The synthetic wallet user and policy-owning P-256 key are distinct test identities. A production user-created policy should use `owner: { user_id: <authenticated Privy user ID> }` and exercise an edit with that user's `user_jwts` authorization context. Privy's [create-policy API](https://docs.privy.io/api-reference/policies/create) supports user owners, and [authorization signatures](https://docs.privy.io/api-reference/authorization-signatures) are required for owner-controlled updates.
