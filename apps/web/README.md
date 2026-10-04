# Web

Generated with the official TanStack Router-only React/Vite starter. Routes live
in `src/routes`; the TanStack plugin generates `src/routeTree.gen.ts`. Do not edit
the generated route tree by hand. `src/router.tsx` is the single router factory.

From the repository root, use `bun run dev` for both applications. The frontend
requests relative `/api` URLs, validated against `@lanatools/contracts`.
See the root README for checks and production routing requirements.

## Solana network

The dashboard reads wallet balances from the network in `VITE_SOLANA_NETWORK`:
`sandbox` (hosted Surfpool), `devnet`, or `mainnet`. Builds fail without it, so
a deployment never shows one network's balances while users deposit on
another. The hosted `master` branch is staging: set `VITE_SOLANA_NETWORK=devnet`
in Cloudflare's build environment, matching the API's `SOLANA_NETWORK=devnet`.
`bun run deploy:web` also builds for devnet. Sandbox is for local development
and automated tests only. `mainnet` also needs `VITE_SOLANA_RPC_URL`, because the public
mainnet RPC refuses token-balance queries. The page checks that the RPC serves
the named network before showing balances.

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
