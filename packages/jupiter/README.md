# Jupiter reads

`@lanatools/jupiter` owns all nine Jupiter read tools and the 18 REST route templates in
[the implementation plan](../../specs/jupiter-read-tools.md). Private Trigger V2
reads and wallet authentication are outside the scope.

| Tool                            | Supported views / input                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jupiter_search_tokens`         | Query or exact mints; optional single-mint eligibility                                               |
| `jupiter_discover_tokens`       | Ranked, tag, recent                                                                                  |
| `jupiter_get_prices`            | Up to 50 unique mints                                                                                |
| `jupiter_get_portfolio`         | Positions by public wallet, staked JUP, platforms                                                    |
| `jupiter_get_lending_markets`   | Earn tokens, Borrow vaults (`main` / `ethena`)                                                       |
| `jupiter_get_lending_positions` | Earn positions by wallets, earnings by wallet/position addresses, Borrow positions by wallets/market |
| `jupiter_get_trigger_orders`    | Public legacy price orders / time-based DCA; active/history and page                                 |
| `jupiter_quote_swap`            | Different input/output mints, positive decimal amount, optional maximum slippage/minimum output      |
| `jupiter_get_swap_venues`       | Full program-ID/label mapping; empty input                                                           |

The package uses Web APIs and accepts an injected fetch implementation for
Workers and deterministic tests. It has no database, app imports or signer.

```ts
import { JupiterClient } from '@lanatools/jupiter'

const client = new JupiterClient({ apiKey: serverManagedKey })
const outcome = await client.read({
  tool: 'jupiter_search_tokens',
  input: { query: 'JUP' },
})
```

All calls use GET on `https://api.jup.ag` with the server key in `x-api-key`.
Redirects are refused using manual redirect handling compatible with Workers. Default request timeout: 10 seconds; complete tool
deadline: 30 seconds. A request can retry once on transport failure or HTTP 5xx. A 429 retries only when a usable Retry-After fits the remaining deadline; otherwise a
structured rate-limit error is returned. Invalid inputs, unusable response
shapes and other HTTP 4xx are not retried. Failed optional eligibility never
repeats successful token metadata lookup.

## Inputs and results

- Search accepts either a trimmed query or up to 100 unique mints. Eligibility
  needs one unique mint in the array. Duplicates are normalized, not rejected.
  Candidate order is preserved and the tool never selects a token automatically.
- Discovery uses `ranked`, `tag`, or `recent`, with a default limit of 20.
  Ranked needs category/interval; tag needs a tag. Tag/recent offset pagination
  slices the provider list locally and is not a stable upstream snapshot.
  Ranked has no next-page contract.
- Prices accepts up to 50 unique mints and reports omitted or unusable price entries in
  `missingMints`. Missing prices are never zero. `createdAt` is the provider's
  token-creation timestamp, not price freshness; preserve `blockId` when supplied.

- Portfolio preserves provider records and fetcher reports. Failed or unknown fetchers
  mark a partial result; missing or empty reports leave completeness unconfirmed. Staking
  amounts retain upstream units.
- Lending preserves amount/rate precision and upstream units; rates are not relabeled
  as APY. Earn earnings normalize either the documented object or array shape to an
  array. Addresses are deduplicated; no undocumented 20-address cap or custom RPC
  input is imposed.
- Legacy orders map wallet to `user` and fix DCA `recurringType=time`. Pagination
  uses explicit `hasMoreData` or `totalPages`; absent signals remain unknown. DCA defaults `includeFailedTx` to false and
  normalizes the upstream `time` array to `orders`.
  These reads do not cover newer product orders.
- Quotes resolve token decimals from metadata and convert decimal strings with exact
  integer arithmetic. Excess fractional precision and amounts outside the token
  base-unit range fail. No `taker` is forwarded; transaction payloads are removed.
  Minimum-output constraints compare against the upstream threshold, with unknown
  satisfaction when it is absent. A failed constraint is reported, not permission
  to execute. Impact/fees retain documented units and the safe provider quote is
  preserved.
- Venue mappings are complete metadata, not pair-specific availability.

Success contains `source`, `network: mainnet-beta`, `fetchedAt`, `data`, and
`warnings`. Optional metadata, new provider fields and nulls pass through
without invented defaults. Unusable top-level responses produce sanitized
errors; usable token records survive unexpected optional data. Eligibility
failures remain visible in successful search results.

The package exports `jupiter`, a `@lanatools/toolkit` provider. Register it on
an MCP server with `registerTools` from `@lanatools/toolkit/mcp`. The host
must enforce access; the package does not grant access itself. The LanaTools
API checks the stored account/client/grant/scope before calling the package.
Keys and provider error bodies never become agent inputs or results.

## Verification

`bun test packages/jupiter/src` covers the 18 REST route templates, partial data,
enrichment, pagination, retries and MCP discovery/calls through an in-memory SDK
transport. `apps/api/src/tools/call-tool.test.ts` exercises local D1 scope enforcement,
cross-client/owner isolation and revocation.

Fixtures are synthetic examples. Authenticated live checks passed for all 18 REST
route templates (20 cases including both Borrow markets) through MCP registration,
a local Worker service binding and the actual API Worker/D1 grant executor. A host
fetch bridge provided outbound networking in the cloud test harness. Missing scope
and revoked grants were denied. Quotes returned no transaction payloads.

The Worker check found and fixed unsupported `redirect: error`; the client now uses
manual handling and rejects redirects. Live legacy DCA additionally requires
`includeFailedTx`, defaulted to false, and returns its records under `time`; these
provider differences have regression coverage. Its initially failing live case
passed after these corrections.

The key is configured only in the ignored local API Worker `.dev.vars`.
Production Worker configuration and the deployed browser OAuth flow remain
unverified. No transactions were created or submitted.
