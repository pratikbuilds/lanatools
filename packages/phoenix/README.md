# Phoenix reads

`@lanatools/phoenix` owns the read-only agent tools for
[Phoenix](https://docs.phoenix.trade) perpetual futures on Solana mainnet.
It calls Phoenix's public HTTP API (`https://perp-api.phoenix.trade`) with an
injected `fetch`. It needs no API key and no wallet signature, and it has no
signer, database or app imports. See [the spec](../../specs/phoenix-read-tools.md).

```ts
import { phoenix } from '@lanatools/phoenix'

const outcome = await phoenix.run('phoenix_get_market', { symbol: 'SOL' }, {})
```

`phoenix` is a [`@lanatools/toolkit`](../toolkit/README.md) provider, so any
MCP server can register its tools with `registerTools`. `run` never throws. It
returns `{ ok: true, result, credits: 0 }` or
`{ ok: false, error: { code, message, retryable }, credits: 0 }`, without
Phoenix's raw error body.

## Units

Phoenix stores sizes as integer lots. The tools return tokens and USDC:

| Phoenix value                                   | Conversion                                             | Example                                    |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| Base lots                                       | `lots / 10^baseLotsDecimals`; decimals can be negative | SOL (2): 2044 → 20.44; kBONK (−2): 3 → 300 |
| Quote lots (collateral, funding, virtual quote) | `lots / 10^6` (USDC)                                   | 6039078 → 6.039078                         |
| Funding rates                                   | Already percent, per one-hour interval                 | annualized = current × 8760                |

Lot conversions are exact decimal strings. Prices and Phoenix's own floats
are numbers trimmed to 10 significant digits.

## Known Phoenix behaviour

- Symbols match case-insensitively (`sol` works); some contain lowercase
  letters (`kBONK`), so input is not upper-cased.
- An unfiltered order history times out for active traders, so the `orders`
  feed requires a `symbol`.
- `limit` on the PnL route does not return the newest buckets, so the tool
  reads the whole series and keeps the newest `limit` points.
- Any valid address returns a trader state; a wallet that never traded shows
  zero collateral.

## Verification

`bun test packages/phoenix/src` covers unit conversion, joins, cursors, input
errors and upstream errors with a fake `fetch`. The fixtures are trimmed live
responses from 2026-10-04.
