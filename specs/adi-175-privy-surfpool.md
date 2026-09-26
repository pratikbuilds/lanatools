# ADI-175 Privy signing proof

## Result, September 26, 2026

`bun run testbed:privy` created a disposable Privy Solana wallet owned by a synthetic test user, with a server key quorum as an additional signer. The signer had a policy allowing `signTransaction` only for a System Program transfer of at most 1,000 lamports to one generated recipient. Privy signed the transaction without broadcasting it. The script sent those signed bytes to a local Surfpool validator and verified the transaction metadata and both balance changes. A 1,001-lamport request was rejected by Privy with a policy-related API error.

| Evidence | Value |
| --- | --- |
| Surfpool RPC | `http://127.0.0.1:8899`, `surfpool 1.0.0-rc1`, offline mode |
| Privy wallet | `wcegcybun8p1ubd318vud4o0`, `Eg98E2mKZymrunFhkrmnoNg1zzXtA7vsaRoLfTrRCeJE` |
| Server quorum | `jk8w1yc2ddrw7ztfnh5ho2ha` |
| Signer policy | `tk1ktrrbury4l0xz78k02dzt` |
| Recipient | `CaUndsWe4BwmmKBxiUakZTmYGb3tvmfHUyLzkj2ThcED` |
| Signature | `3Eq7xZoiZyf748Ztov2ZKZkZgBQSUHJxH2KTmfLV5pxVuDBczAmEd6eAzq4JVyZJo7WTie2W5TnypGUeog3w2Kuj` |
| Surfpool result | slot 331, `meta.err: null`, recipient +1,000 lamports, payer -6,000 lamports including 5,000 fee |
| Final status read | `confirmationStatus: finalized`, `err: null` |

Surfpool state is temporary. The transaction signature and local finality do not imply devnet or mainnet settlement. The synthetic user and wallet prove the server signer on a user-owned wallet; they do not prove a real user's login, consent, or revocation UI. Pay Kit and USDC payment are ADI-176.

## Reproduce

Use a dedicated Privy development app. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in an ignored `.env` file. Do not use production credentials. In one terminal run `surfpool start --offline --no-tui --no-studio --no-deploy`. In another run `bun --env-file=.env run testbed:privy`. Each run creates a fresh test user, wallet, quorum, and policy in that Privy app. The P-256 server key exists only in the process and is discarded when it exits. No Solana wallet key or authorization private key is printed or saved.

The script first checks the Surfpool RPC, then creates a 1-of-1 key quorum with a P-256 public key, a narrow Solana policy, and a user-owned wallet with that quorum as an additional signer. It requests local SOL, signs through Privy, broadcasts through Surfpool, verifies balances and fee, and asks Privy to sign an over-limit transfer. A successful policy rejection is required for the command to pass.

## Failure modes seen and checked

- Privy rejects policy and rule names of 50 characters or more. The proof uses short names.
- The Privy Node SDK expects a base64 PKCS#8 authorization key. The proof uses `generateP256KeyPair` from that SDK.
- A signature response alone does not prove execution. The proof checks the signed wire transaction, Surfpool transaction metadata, and balance deltas.
- An ordinary API error cannot count as a policy denial. The negative request must return a Privy API error mentioning policy or denial.
- The local validator must be running before the script creates Privy resources. The script checks it first.

Privy documents [server authorization contexts](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server), [additional signers](https://docs.privy.io/wallets/using-wallets/signers/quickstart), [Solana policy conditions](https://docs.privy.io/controls/policies/example-policies/solana), and [sign-only Solana transactions](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction). The policy examples use `signAndSendTransaction`; this proof specifically uses `signTransaction` so LanaTools controls the Surfpool broadcast.
