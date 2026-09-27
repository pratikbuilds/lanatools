# ADI-176 Pay Kit payment from a server-authorized Privy wallet

Status, September 27, 2026: the payment path is built and verified with a local keypair payer. The live Privy run is still pending; until it passes, this is not evidence that Pay Kit pays with a Privy wallet.

## What the proof runs

`packages/testbed/src/paykit-server.ts` is one local process on `127.0.0.1:1403`:

- a Pay Kit merchant (`@solana/pay-kit` 0.12.0) with a fixed 0.01 USDC charge at `/merchant/fortune`, offering MPP `charge` and x402 `exact`, settling on local Surfpool (`127.0.0.1:8899`, a mainnet fork, so the real USDC mint exists);
- the payer: a Pay Kit client whose signer is `createPrivyPayerSigner` (`privy-payer-signer.ts`), which sends each transaction to Privy `signTransaction` with a server key and returns only the wallet's signature;
- `POST /testbed/pay`, which verifies the caller's Privy access token, creates a wallet owned by that user with the server key quorum as an additional signer and **no Privy policy**, funds it with Surfpool setup calls, pays, and returns checks.

The local-only page in `apps/proof` (`bun run proof`, port 5174) signs the user in and calls `/testbed/pay` through its Vite proxy. The access token goes only from the browser to the local server; it is never pasted or stored.

## Controls under test

The control is a transfer amount cap, not transaction inspection. Pay Kit `permissions` allow only the merchant origin, `localnet` (plus the default mainnet, see below), known stablecoins, and a per-payment cap. A challenge above the cap throws `PermissionDeniedError` before any transaction is built. The signer adapter does not decode instructions; the merchant verifies what it receives.

Each paid run checks: HTTP 200 with the merchant body, a receipt naming the transaction (`payment-receipt` for MPP, `x-payment-response` for x402), exactly one Privy signing call, wallet USDC down by exactly 10,000 base units, merchant USDC up by the same amount, and wallet SOL unchanged (the merchant pays the fee). The denied run uses a 0.005 USD cap and checks the rejection, zero signing calls, and unchanged balances.

## Evidence so far

| Check | Result |
| --- | --- |
| Keypair payer under Bun, MPP | 200, merchant +10,000, 1 signing call |
| Keypair payer under Bun, x402 | 200, merchant +10,000, 1 signing call |
| Keypair payer, cap 0.005 USD | `PermissionDeniedError` (`amount_exceeds_limit` from both rails), 0 signing calls |
| `paykit-admission.test.ts` | over-cap payment refused before signing for auto, MPP and x402; RPC unreachable by design |
| Privy payer, MPP / x402 / denied | **not yet run** |

The main open question is whether Privy signs a transaction whose fee payer is the merchant and whose fee-payer signature slot is still empty.

## Feasibility notes

- **Signer type:** `createPayKitClient` types `signer` as `KeyPairSigner`, but the MPP `charge` and x402 `exact` paths only call `signTransactions`. The proof passes a remote partial signer with a type cast. A Pay Kit upgrade could start relying on keypair-only members.
- **Kit version:** Pay Kit declares `@solana/kit >=6.5.0` but fails to load on kit 8.3 (`getMinimumBalanceForRentExemption` is gone). The testbed pins kit `~6.10.0`, the version Pay Kit's own lockfile uses.
- **x402 network identity:** on Surfpool the merchant advertises x402 with the mainnet CAIP-2 ID because the fork keeps mainnet's genesis hash. The client cannot tell the fixture from mainnet by network alone. The proof relies on the origin allowlist and the local RPC; production must not treat the network check as the only guard.
- **Uncertain payments:** the fixed-charge client does not retry, and the merchant broadcasts. A lost response after settlement surfaces as an error with an unknown outcome. Reconciliation belongs to ADI-189.
- **Not covered:** x402 `upto`, MPP subscriptions and sessions.

## Reproduce

Put `PRIVY_APP_ID` and `PRIVY_APP_SECRET` for a development Privy app in the ignored root `.env`, and the public app ID as `VITE_PRIVY_APP_ID` in `apps/proof/.env.local`. Run `surfpool start --no-tui --no-studio --no-deploy`, `bun --env-file=.env run testbed:paykit`, and `bun run proof`. Sign in at `http://localhost:5174` and use **Pay with MPP**, **Pay with x402**, and **Try denied payment**. Ctrl-C on the proof server archives the wallets it created and deletes its key quorum; a failure prints the resource ID.
