# Helius read tools

`@lanatools/helius` owns tool schemas, provider requests, safe errors and agent-facing output. It has no OAuth, database, Cloudflare bindings, user identity or payment logic.

```ts
import { helius } from '@lanatools/helius'

const outcome = await helius.run(
  'get_accounts',
  { addresses },
  { rpcUrl, fetch },
)
// { ok: true, result, credits } or { ok: false, error: { code, message, retryable }, credits }
```

`helius` is a [`@lanatools/toolkit`](../toolkit/README.md) provider, so any
MCP server can register its tools with `registerTools`. `runHeliusTool` is the
same function as `helius.run`.

The server supplies its existing `SOLANA_RPC_URL`; agents cannot choose a network or URL. Read tools trust the server's network configuration without a genesis-hash probe; payments independently verify that their RPC serves the configured network. API keys never enter output, exceptions, or tool descriptions.

## Read order

1. `src/tool.ts` and `src/index.ts`: the schema/handler contract and registry
2. `src/client.ts`: injected fetch, 10-second request deadlines, lossless JSON, credit accounting and redaction
3. `src/tools/get-accounts.ts`: account kinds without raw byte payloads
4. `src/tools/get-transactions.ts` and `src/transactions.ts`: signature status and transaction shaping
5. `src/core.test.ts`: offline wire fixtures and security/precision checks

Adding a tool means exporting it in `heliusTools`; `runHeliusTool` handles validation, execution, safe output and credits. Input schemas are strict so unknown fields, including network overrides, are refused. Metadata from the chain is untrusted data, never instructions.

## Output and costs

Amounts are decimal strings, avoiding floating-point rounding. Known parsed token account data is returned; unknown accounts expose byte size only. Transactions include `found:false` when RPC returns no confirmed transaction; this is not proof a submitted signature will never land. `detail:full` adds instructions. Version 0 is the current explicit transaction-version ceiling.

Credits are estimates, not a provider invoice: each successful standard RPC request adds 1. A failed request adds zero, but earlier successful calls in a partially failed tool run remain counted. The API records credits in its activity ledger and omits them from tool responses. There are no read quotas or payment charges in this package. Requests are not automatically retried, and transaction batches are sequential to avoid bursts on the shared plan.

## Verify

- `bun test packages/helius` runs offline fixtures
- `bunx tsc -p packages/helius` checks the package
- The repository `bun run check` includes this package
- Offline fixtures do not establish live provider behavior; the MCP verification script does not exercise these tools yet

Reference contracts: [Kit transport](https://www.solanakit.com/api/functions/createSolanaRpcFromTransport), [Solana accounts](https://solana.com/docs/rpc/http/getmultipleaccounts), [Solana transactions](https://solana.com/docs/rpc/http/gettransaction).
