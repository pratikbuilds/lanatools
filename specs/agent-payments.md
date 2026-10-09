# LanaTools agent payments spec

Status: agreed task scope, September 24, 2026. This spec covers the agent-payment foundation. [product.md](../product.md) remains the overview of the full product.

## Purpose

LanaTools gives one person a hosted MCP server through which their AI clients can discover and use the full pay.sh catalog. The person creates a Privy embedded Solana wallet, funds it, and gives each connected client its own spending limit. LanaTools makes the payment from that wallet, returns the provider's result to the client, and shows the person what happened.

The first proof is a real paid catalog call from a connected MCP client without local payment tooling. A second client must be able to use the same wallet with a different limit.

## User and account

- The product serves individual users. There are no teams, roles, or shared accounts.
- Privy handles sign-in with Google or an external Solana wallet. A user can link both methods to the same account. Linking requires an authenticated user action; matching a wallet or email never silently merges accounts.
- The user creates one Privy embedded Solana wallet for agent payments. An external wallet is a sign-in and linking method, not the source of automatic agent payments.
- The app shows the embedded wallet address and balances. Initially the user funds it by sending USDC. An onramp is later work.
- Signing out of the app does not revoke an active MCP grant. The user can disconnect clients and disable wallet delegation separately.

## Connecting a client

1. The user gives an MCP client the hosted LanaTools MCP URL. The final production URL is not set by this spec.
2. The client uses MCP OAuth discovery and starts an authorization code flow. The user signs into LanaTools with Privy if needed.
3. Consent shows the client's claimed name, redirect destination, requested access, and the spending limit. The name alone is not proof of the client's identity.
4. The user approves a limit for that client. No new client can spend before this approval. The grant is bound to the Privy user, embedded wallet, and OAuth client identity.
5. The client receives an access token for the LanaTools MCP resource. The user sees that connection in the app.

Use the strongest OAuth flow compatible with the target MCP clients: protected-resource and authorization-server discovery, exact redirect URI validation, authorization code with S256 PKCE, issuer and audience checks, short-lived access tokens, refresh-token rotation where supported, and effective revocation. Prefer verifiable client metadata where clients support it; keep a compatible registration path for clients that do not. Reauthorization of an existing grant does not reset spending. A browser cookie alone must never create or renew a spending grant.

The existing `mcp-oauth` project is a protocol and SIWS reference. Its wallet-address user ID, demo tools, and remembered-client cookie are not the LanaTools account or authorization model.

## MCP tools and catalog calls

- Expose tools to search the pay.sh catalog, inspect a service and its endpoints, and call a catalog endpoint. The tools use the catalog's exact gateway URL and documented request shape.
- Expose the entire pay.sh catalog. LanaTools does not maintain a smaller launch allowlist or exclude a provider because of its action type. A service can be discovered even when its payment is currently unavailable because of balance, provider failure, or an unbounded charge.
- Before a paid call, inspect the live payment challenge. Catalog metadata is discovery information, not a binding price. Use Pay Kit for supported payment and retry flows, with Privy wallet signing mediated by the LanaTools server.
- A client may invoke free catalog endpoints. Paid calls must pass the same client authentication, grant, and request validation as free calls.
- Catalog content, endpoint descriptions, provider responses, and payment challenges are untrusted data. They cannot change the client's grant or instruct LanaTools to send wallet funds outside the validated payment flow.

## Spending limit

- Each connected OAuth client has an independent, user-set cumulative maximum in USD for payments it makes through the shared wallet. The limit does not reset on a timer or reconnection. The user can change it at any time.
- The app shows the maximum, spent, reserved, and remaining amount for each client. It records the payment token and exact token amount for every call. A client may use a catalog endpoint only when the wallet holds a token accepted by its live challenge.
- Before signing, LanaTools must know the maximum wallet payment exposure for the call or session. It reserves that amount against the client's remaining limit atomically, including across concurrent requests. If the live terms cannot establish a ceiling within the remaining limit, it does not sign.
- When the call ends, LanaTools replaces the reservation with the spend, or frees it. A user lowering a limit below the amount already spent blocks further spending; it does not erase history.
- The limit governs payments initiated by that OAuth client through LanaTools. It does not claim to cap unrelated transfers the wallet owner makes elsewhere, provider charges outside the wallet, or changes in a token's market value.
- Privy wallet policies and server signer controls are an additional wallet boundary. LanaTools owns the per-client cumulative limit and ledger; Privy's documented Solana policies do not supply that aggregate per-client counter.

## Activity and control

The app shows every connected client, its claimed name and redirect destination, when it connected and last called, grant status, limit, spent amount, and remaining amount. The user can change a limit or revoke one client without resetting another client's record. A wallet-wide emergency stop can disable server signing for all clients.

For each call, show the client, catalog provider and endpoint, time, status, quoted or reserved amount, settled amount and token, and the payment transaction or receipt when one exists. Record free calls, denials, provider errors, and failed payments too. Keep request and response bodies out of the activity record by default because catalog calls may contain private data.

Every call ends paid or failed, decided by the endpoint's answer. Once the payment is signed, an endpoint that serves the call was paid; any other answer, or none, fails the call and frees its reservation. A failure after signing tells the agent the wallet may have been charged and gives the endpoint's reason when it names one, so the agent does not blindly repeat it.

## Initial scope and later work

Initial scope includes Privy sign-in and wallet creation, client OAuth connection, the full catalog through MCP, automatic payments within independent client limits, funding by wallet transfer, activity, and revocation. It includes all payment forms exposed by catalog services as a product goal; implementation must prove each payment form with Pay Kit and a server-authorized Privy signer before claiming support.

An onramp, first-party Solana data tools, transaction preparation outside the catalog, payment URL routing, LanaTools pricing, and a launch date are later decisions. No marketing page may show illustrative activity or costs as real usage.

## Acceptance checks

1. A new user signs in with Google or an external Solana wallet, creates an embedded wallet, funds it, and sees its balance.
2. A real MCP client completes OAuth and appears in the app with the approved limit. A second client connects to the same wallet with a different limit.
3. Each client searches the catalog, inspects an endpoint, and makes a real paid call. The result and receipt return to the client, and the app attributes the spend to the right client.
4. Concurrent calls cannot exceed a client's remaining limit. Editing or revoking one client's grant changes its next call immediately without changing the other client.
5. A client that reconnects retains its spent amount. Failed and ambiguous payment attempts do not create a second charge on retry.
6. Login, OAuth, wallet delegation, payment rails, and activity remain verifiable end to end in a browser and an actual MCP client, not only through unit or HTTP health checks.

## Source notes

- [pay.sh catalog](https://pay.sh/docs/using-pay/skills) and [payment schemes](https://pay.sh/docs/sdk/typescript/schemes)
- [Privy authentication](https://docs.privy.io/authentication), [account linking](https://docs.privy.io/user-management/users/linking-accounts), and [Solana policy limits](https://docs.privy.io/controls/policies/stateful-policies)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
