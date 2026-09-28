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
another; set it in the Cloudflare build environment. The dev server and tests
use `sandbox`. `mainnet` also needs `VITE_SOLANA_RPC_URL`, because the public
mainnet RPC refuses token-balance queries. The page checks that the RPC serves
the named network before showing balances.
