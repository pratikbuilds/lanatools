# Privy wallet access for payments and transaction tools

One Privy user can own a Solana wallet that serves several MCP clients. The clients can have different payment limits. The same user can also create additional embedded Solana wallets. These are separate choices: signer policies control how a wallet may be used, while separate wallets separate balances and addresses.

## Keep the Pay Kit restriction on its signer

Privy supports multiple additional signers on one wallet. An additional signer can have an override policy, and Privy evaluates that signer's policy when it authorizes a request. A policy attached to the Pay Kit signer therefore does not become the policy for every other signer on the wallet. See [Privy's conditional signer policies](https://docs.privy.io/recipes/wallets/conditional-signer-policies).

The [current testbed](../packages/testbed/src/paykit-server.ts) creates a user-owned wallet with a server key quorum in `additional_signers`. It puts the USDC `TransferChecked` rule in that signer's `override_policy_ids`. `createPrivySigner` uses the server key for Pay Kit calls. The local `SpendLimit` reservation also runs in this payer path. The testbed does not yet connect MCP clients or offer a general transaction tool.

Future transaction tools can use the same wallet through user authorization or a different delegated signer with its own policy. They must not reuse the Pay Kit signer for general transactions. The server must choose the authorized signer from the authenticated tool and grant; a client-supplied signer ID or tool name cannot grant broader access. Adding an additional signer to a user-owned wallet requires an authorized wallet update. See [Privy's signer setup](https://docs.privy.io/recipes/wallets/conditional-signer-policies).

| Action                      | Authorizer                          | Limit that applies                                                       |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Pay Kit MPP or x402 payment | Pay Kit signer                      | Its Privy policy, Pay Kit permissions, and the app's payment reservation |
| General transaction         | User or a separate delegated signer | That authorization path's policy and approval rules                      |

A signer policy follows the signer, not the purpose of a request. A general transaction sent through the Pay Kit signer can be denied by its restrictive policy. A more capable signer on the same wallet can move the same funds, so the Pay Kit policy is a payment-path limit, not a wallet-wide withdrawal cap.

## Give MCP clients independent payment limits

The [product spec](../specs/agent-payments.md) gives each connected OAuth client its own cumulative payment limit. The server must authenticate the client, check its grant, and atomically reserve the maximum exposure before Pay Kit signing. It records settlement against that client's balance and keeps an uncertain payment reserved until it is reconciled. A client cannot choose another client's grant or signer.

If each client also needs a different Privy-enforced _per-transaction_ cap, assign each one an additional signer with its own override policy. This does not replace the app's cumulative ledger. Privy's documented stateful aggregations currently list Ethereum signing methods, not Solana `signTransaction`; the Solana `TransferChecked.amount` rule in the testbed bounds an instruction, not total wallet or client spend. See [Privy's stateful policy methods](https://docs.privy.io/controls/policies/stateful-policies) and [policy evaluation](https://docs.privy.io/controls/policies/overview).

The current testbed has one server quorum and an in-memory wallet limit per user. Neither provides durable per-client isolation across requests, restarts, or server instances. This is still product work, not a capability proven by the browser payment test.

## Create more than one wallet for a signed-in user

Privy's Solana `useCreateWallet` hook accepts `createAdditional: true` to create another embedded wallet for the same user. The wallet has its own address and balance; the user can stay signed in with the same Google-linked Privy account. See [Privy's wallet creation docs](https://docs.privy.io/wallets/wallets/create/create-a-wallet).

Use another wallet when the funds themselves need separation. Use additional signers when several authorized paths should share one balance. Neither choice removes the need to authenticate MCP clients and enforce their cumulative payment limits.
