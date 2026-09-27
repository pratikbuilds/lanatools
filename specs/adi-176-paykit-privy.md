# ADI-176 Pay Kit payment from a server-authorized Privy wallet

Status, September 27, 2026: the payer targets the existing `pay --sandbox gate api` merchant configured by `packages/testbed/merchant.yaml`. A sandbox-funded keypair paid that YAML merchant through Pay Kit and received HTTP 200 with an MPP receipt. The Privy payer has not yet been run against this merchant.

## Flow

Run `bun run testbed start` to serve the YAML merchant at `http://127.0.0.1:1402/api/v1/fixed`. It advertises an MPP `charge` of 0.01 USDC on the hosted Surfpool sandbox. Run `bun --env-file=.env run testbed:paykit` for the payer and `bun run proof` for the local-only sign-in page. The browser sends its Privy token to the payer on `127.0.0.1:1403`; the payer verifies it, creates a disposable user-owned Privy wallet with a server key quorum, and funds that wallet on Surfpool. The server key is held only in the payer process.

Before paying, the payer reads the YAML merchant's live 402 challenge and checks its amount, token mint, and localnet network. Pay Kit calls that same gateway URL with the Privy-backed partial signer. The payer checks the receipt, confirmed transaction, signing count, payer debit, merchant credit, and payer SOL balance. The denied mode uses a 0.005 USD cap and requires an `amount_exceeds_limit` rejection before signing. The gateway offers MPP only, so this proof makes no x402 claim.

## Evidence and limits

- `pay --sandbox curl` paid the YAML merchant and the original testbed check verified its receipt and merchant balance change.
- A Pay Kit keypair client rejected the YAML challenge with `amount_exceeds_limit` under a 0.005 USD cap. With 0.01 USD allowed, it returned HTTP 200 and an MPP receipt from the same gateway.
- The prior Privy MPP and x402 signatures (`2Ar9cbWYsaSTiTNhT1NzaUhjNicKmXmDhxtzcfqd2ybQZZS8tA2zyCLqHpmKrtgaMvXXp9QMq5tAbdHmcFg9aApN`, `VXkf2w1H45R65vZVA1nZCaKC8hSG2jskiZzkmirhZ3FtGqmy7iWrF5Q722NQKaC6UH4nUjzec4qRqk3D8qWqoBx`, and `4sB4LtyYNnADrEvjiNNSk7YqNEBoxXf7FEmxye4fp8VLg2o2ubu14NDfdGx1HUpdd7tMmMV7gckKcUs8A7qAW1ks`) came from a separate local Pay Kit merchant on Surfpool, not from the YAML gateway. They establish the signer seam for those protocols but do not establish the current end-to-end flow.
- This is sandbox settlement. Production catalog calls require catalog endpoint selection, live challenge validation, per-client grant and cumulative reservation, funding on the challenged network, and uncertain-payment reconciliation. The fixed per-payment Pay Kit cap does not provide those controls.

## Reproduce

Use a dedicated Privy development app. Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in the ignored root `.env`, and `VITE_PRIVY_APP_ID` in `apps/proof/.env.local`. Run `bun run testbed start`, `bun --env-file=.env run testbed:paykit`, and `bun run proof`. Sign in at `http://localhost:5174` and use **Pay with MPP** and **Try denied payment**. Ctrl-C on the payer archives wallets and deletes its key quorum; check the process log for cleanup failures.
