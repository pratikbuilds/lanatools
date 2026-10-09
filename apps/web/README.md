# Web

Generated with the official TanStack Router-only React/Vite starter. Routes live
in `src/routes`; the TanStack plugin generates `src/routeTree.gen.ts`. Do not edit
the generated route tree by hand. `src/router.tsx` is the single router factory.

From the repository root, use `bun run dev` to run it with the API and MCP
Workers on the network selected in the root `.env`. The frontend
requests relative `/api` URLs, validated against `@lanatools/contracts`.
See the root README for checks and production routing requirements.

## Solana network

`SOLANA_NETWORK` (`devnet` or `mainnet`) selects the network for the API and
browser. Local development reads it from the root `.env`; explicit process
environment values take precedence for ordinary web builds. Missing or
unsupported values fail validation. `VITE_SOLANA_NETWORK` is no longer used.

For deployments, `bun run deploy:web` reads `SOLANA_NETWORK` from
`apps/api/wrangler.jsonc`, the same configuration used to deploy the API.
This overrides local settings so the deployed API and browser agree.
Shared network addresses, labels, and Explorer URLs live in
`packages/contracts/src/networks.ts`.

Dashboard balances come from `/api/wallet/balances`,
which reads them with the API's server-side `SOLANA_RPC_URL`, so the provider
key never reaches the page. The API reports its network, and the page refuses
to show balances from a network other than the one it names. The public
transaction page uses the wallet adapter for signing and the API for submission.

## Tool activity and estimated credits

The dashboard activity feed combines completed payment requests with provider
tool calls. `GET /api/activity` returns a discriminated `kind` (`payment` or
`tool`), sorted newest first with source-aware cursors. Existing payment-only
cursors remain readable. Client and outcome filters apply across both ledgers;
`ok` selects successful tools, and `failed` includes both failed payments and
failed tools. Totals cover the full filtered history, not only the current page.

Tool rows, their detail drawers, and each connected client's card label provider
credits as estimates. Helius does not report an actual per-call cost. Estimated
credits remain separate from wallet spending and payment limits, including when
a provider call fails. The client total survives disconnecting and reconnecting
the same client. The activity heatmap counts both types of call; its dollar
amounts still include only payments.

API activity reads and client aggregates are always restricted to the signed-in
user. Tool details expose the tool, provider, verified network when available,
status, elapsed time, and a safe error code, without tool arguments or results.
