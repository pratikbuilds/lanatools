# Jupiter reads

`@lanatools/jupiter` owns Jupiter REST calls and read-tool contracts. This first
slice implements `jupiter_search_tokens`, `jupiter_discover_tokens`, and
`jupiter_get_prices`. The other six tools in
[the implementation plan](../../specs/jupiter-read-tools.md) are follow-up work.
Private Trigger V2 reads and wallet authentication are outside the scope.

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
Redirects are refused. Default request timeout: 10 seconds; complete tool
deadline: 30 seconds. A request can retry once on transport failure, HTTP 5xx or 429. Retry-After is respected when it fits the remaining deadline; otherwise a
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
- Prices accepts up to 50 unique mints and reports omitted ones in
  `missingMints`. Missing prices are never zero. `createdAt` is the provider's
  token-creation timestamp, not price freshness; preserve `blockId` when supplied.

Success contains `source`, `network: mainnet-beta`, `fetchedAt`, `data`, and
`warnings`. Optional metadata, new provider fields and nulls pass through
without invented defaults. Unusable top-level responses produce sanitized
errors; usable token records survive unexpected optional data. Eligibility
failures remain visible in successful search results.

`@lanatools/jupiter/mcp` exports registration and result formatting. Its injected
executor must enforce access; the package does not grant access itself. The API
checks the stored account/client/grant/scope before calling the package.
Keys and provider error bodies never become agent inputs or results.

## Verification

`bun test packages/jupiter/src` covers the six REST route templates, partial data,
enrichment, pagination, retries and MCP discovery/calls through an in-memory SDK
transport. `apps/api/src/jupiter.test.ts` exercises local D1 scope enforcement,
cross-client/owner isolation and revocation.

Fixtures are synthetic examples, not live-response proof. Authenticated Jupiter
responses remain unverified until the managed server key is available. Tests
make no paid calls or transactions.
