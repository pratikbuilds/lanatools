# ADI-175 Privy signing proof

## Result, September 26, 2026

The original run of `bun run testbed:privy` created a disposable Privy Solana wallet owned by a synthetic test user, with a server key quorum as an additional signer. The signer had a policy allowing `signTransaction` for System Program transfer instructions of at most 1,000 lamports to one generated recipient. The proof code checked that the transaction contained exactly one intended transfer before asking Privy to sign it. Privy signed without broadcasting; the script sent those bytes to a local Surfpool validator and verified the transaction metadata and both balance changes. A 1,001-lamport request was rejected by Privy with a policy-related API error. The current script replaces this synthetic user with a real authenticated Privy user and tests that user's policy edits; the table below records the earlier run only.

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

Surfpool state is temporary. The transaction signature and local finality do not imply devnet or mainnet settlement. The earlier synthetic user and wallet proved the server signer on a user-owned wallet; they did not prove a real user's login, consent, or revocation UI. Pay Kit and USDC payment are ADI-176.

Privy evaluates Solana policy rules for each instruction, so the 1,000-lamport condition is not a transaction-wide or cumulative spending cap. The proof code rejects a transaction with two 1,000-lamport transfers before it reaches Privy. A production signing path must keep this single-transfer check or enforce a transaction total and a separate cumulative budget.

## Reproduce

Use a dedicated Privy development app. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in an ignored root `.env` file. Put the public app ID in `apps/proof/.env.local` as `VITE_PRIVY_APP_ID`. Do not use production credentials. Run `bun run proof`, open `http://localhost:5174`, sign in as a test user, and click **Copy test token**. Add the token to the ignored root `.env` as `PRIVY_USER_ACCESS_TOKEN`. Do not put the token in chat or source control. In one terminal run `surfpool start --offline --no-tui --no-studio --no-deploy`. In another run `bun --env-file=.env run testbed:privy` before the token expires. Each run creates a fresh wallet, quorum, and policy owned by that authenticated Privy user. The P-256 server key exists only in the process and is discarded when it exits. No Solana wallet key or authorization private key is printed or saved. The script then attempts to archive its wallet and delete its quorum and policy even when a proof step fails. A cleanup failure prints the resource ID and makes the run fail. The policy deletion needs the user's JWT; the unresolved exchange failure can leave that policy in the development app for later cleanup. Earlier runs did leave remote test resources.

The current script uses `@solana/kit` to construct and inspect Solana transactions, verify the Privy wallet signature, submit the signed bytes, and check confirmation. This migration has passed static checks but has not had a live Privy or Surfpool rerun.

The script first checks the Surfpool RPC and verifies the user's access token. It then creates a 1-of-1 key quorum with a P-256 public key, a narrow user-owned Solana policy, and a wallet owned by the same user with that quorum as an additional signer. It checks that the local single-transfer guard rejects two individually allowed transfers, requests local SOL, signs through Privy, broadcasts through Surfpool, verifies balances and fee, and asks Privy to sign an over-limit transfer. Next it asks Privy to reject a server-only policy increase, uses the user's JWT to increase the limit and sign a formerly denied transfer, then uses the user's JWT to decrease the limit and checks that signing is denied again. The edited signatures are not broadcast.

## Failure modes seen and checked

- Privy rejects policy and rule names of 50 characters or more. The proof uses short names.
- The Privy Node SDK expects a base64 PKCS#8 authorization key. The proof uses `generateP256KeyPair` from that SDK.
- A signature response alone does not prove execution. The proof checks the signed wire transaction, Surfpool transaction metadata, and balance deltas.
- Two transfer instructions can each satisfy Privy's per-instruction limit. The proof rejects that transaction locally before signing.
- An ordinary API error cannot count as a policy denial. The current proof accepts only a structured `policy_violation` error code with HTTP 400 or 403, and rejects unrelated failures. This stricter check still needs a live rerun to confirm Privy's actual response code for this app.
- The local validator must be running before the script creates Privy resources. The script checks it first.
- The user's access token expires after roughly one hour. Refresh it from the login page before rerunning the proof.

Privy documents [server authorization contexts](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server), [additional signers](https://docs.privy.io/wallets/using-wallets/signers/quickstart), [per-instruction Solana policy evaluation](https://docs.privy.io/controls/policies/overview), [Solana policy conditions](https://docs.privy.io/controls/policies/example-policies/solana), and [sign-only Solana transactions](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction). The policy examples use `signAndSendTransaction`; this proof specifically uses `signTransaction` so LanaTools controls the Surfpool broadcast.

## Earlier policy edit authorization run

`bun --env-file=.env run testbed:privy-policy-edit` passed against the development Privy app and local Surfpool on September 26, 2026. It created separate disposable P-256 keys for a simulated user and server. The policy was owned by the user key, while the server key was an additional signer on a synthetic user's wallet. Privy rejected the server key's attempt to increase the rule from 1,000 to 2,000 lamports (HTTP 403). A user-key-authorized increase succeeded and allowed a 1,001-lamport transaction signature; a user-key-authorized decrease to 500 lamports then denied that same signing request. No transaction was broadcast.

This earlier run proved a policy edit boundary between two generated keys. It did not prove a real user's Privy login or access-token exchange. Its synthetic wallet user and policy-owning P-256 key were distinct test identities, so the standalone script was removed. The current combined proof uses `owner: { user_id: <authenticated Privy user ID> }` and the user's `user_jwts` authorization context. Privy's [create-policy API](https://docs.privy.io/api-reference/policies/create) supports user owners, and [authorization signatures](https://docs.privy.io/api-reference/authorization-signatures) are required for owner-controlled updates.

The local proof page obtains a normal user session token, and the script consumes it from `.env`. The user-key authorization step remains unverified as described below. This is not a production policy editor or proof of per-edit consent: a server holding a valid user JWT can request user-authorized updates during the token lifetime. Production must scope how and when that token is available to server-side policy changes.

## Authenticated run, September 26, 2026

The revised proof was run twice with an actual user who signed in through the local Privy page. The second run used a fresh login and a new session token. On both runs, the SDK verified the JWT signature, audience, and expiry locally; created a policy and wallet owned by that user; signed and broadcast a 1,000-lamport transfer; verified Surfpool balances; rejected a 1,001-lamport signing request; and rejected the server key's policy increase with HTTP 403.

The user-authorized increase did **not** pass. The Node SDK attempted to exchange the fresh access token for a user signing key, but Privy's `POST /v1/wallets/authenticate` returned HTTP 400 `Invalid JWT token provided`. The local JWT verifier accepted the same token and the audience matched the app ID. The policy stayed at its original 1,000-lamport limit; the subsequent increase, decrease, and signing-after-edit checks were not reached. This is an unresolved Privy API or app-configuration issue, tracked in [ADI-196](https://linear.app/0xpratik/issue/ADI-196/resolve-privy-user-key-exchange-failure-for-policy-edits), not evidence that the user edit works. The code keeps the attempted edit as a failing live gate until this exchange is resolved.

### Hypotheses for the later test

- **Privy app or account configuration:** The wallet API may require a user-signing setting or account state that local JWT verification does not check. The dashboard shows TEE wallets enabled and a 60-minute signing-key duration, but those observations do not establish that user-key exchange is configured correctly.
- **Privy service or SDK compatibility:** `@privy-io/node` sends the access token to `/v1/wallets/authenticate` as documented. A mismatch between the current React-issued token and wallet API exchange could explain the HTTP 400. This has not been isolated to the SDK or service.
- **Session state:** The backend may reject a session that local cryptographic verification still accepts. A new login and session failed the same way, making a single stale token unlikely.

When resuming, obtain a fresh test token from the local page without sharing it in chat, rerun the proof, then compare the documented user-key exchange with Privy's current API behavior. If the same 400 persists, send Privy support the app ID, SDK version, request time, and response/correlation ID, but never the JWT or app secret. Keep this PR's user-edit result marked unverified until both increase and decrease checks pass live.
