# Jupiter read tools: implementation plan

Issue: [ADI-217](<https://linear.app/0xpratik/issue/ADI-217/finalize-jupiter-mcp-read-tool-spec>)

Status: first implementation slice is implemented: package foundation, token search/discovery/prices, grant checks and MCP registration. The other six tools remain follow-up slices. Authenticated live checks passed for all six implemented REST route templates through an in-memory MCP client; production configuration and deployed OAuth integration remain unverified. Pratik requested lighter validation and a dedicated package. This plan replaces the earlier validation-heavy approach. The proposed wallet-connect helper and browser wallet-authentication flow have been removed at Pratik’s request. The scope is nine tool names and 18 public-address/API-key read operations. Private Trigger V2 endpoints are removed from this issue.

## Package and application boundaries

Create `packages/jupiter`, named `@lanatools/jupiter`, as a private Bun workspace package. It owns all nine read-tool definitions, input/output types, provider calls, normalizations and focused tests. Do not distribute Jupiter business logic across the app folders.

Proposed layout:

```text
packages/jupiter/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts
    client.ts                 # injected fetch, key, timeout and bounded retries
    types.ts                  # success/error envelopes and provider records
    inputs.ts                 # lightweight schemas shared with MCP registration
    tools/
      search-tokens.ts
      discover-tokens.ts
      get-prices.ts
      get-portfolio.ts
      get-lending-markets.ts
      get-lending-positions.ts
      get-trigger-orders.ts
      quote-swap.ts
      get-swap-venues.ts
    mcp.ts                    # tool definitions, registration, result formatting
    fixtures/
```

Put meaningful tests beside the modules they exercise. Module names are guidance, not a requirement to create empty scaffolding.

* Package root export: typed Jupiter read client/functions and results. Inject Fetch-compatible transport and server-side credentials; use Web APIs for Cloudflare Worker compatibility. No Node-only runtime, app imports, database dependency or transaction signer.
* Package `./mcp` export: the nine named tool registrations, descriptions, schemas, annotations, summaries and structured results. Accept an injected authorized executor instead of holding grants/secrets. Use the existing MCP server/Zod versions; keep MCP dependencies confined to this entry point.
* `apps/mcp`: call package registration; use existing `withGrant` and the API service binding. Thin transport and existing grant wiring.
* `apps/api`: import package client, bind `JUPITER_API_KEY`, check the current grant/scope and execute typed reads through `McpAccessService`. Keep a small typed read dispatch method, not nine duplicated provider implementations.
* `packages/contracts`: add the shared OAuth scope `jupiter:read`. Jupiter-specific read schemas remain in `@lanatools/jupiter`.
* `apps/web` and MCP consent UI: display “Jupiter access” using the existing consent flow. Add no wallet-login UI. Payment spending limits do not apply to this read scope.

A request travels through MCP registration → API service binding → current grant checks → package read function → Jupiter REST → structured result. Recheck grants inside the API boundary, not just against the OAuth token. API keys never appear in agent inputs or results. No JWT input, wallet-session store, connection tool or challenge/verify/refresh client is implemented in this phase.

## Validation and shared behavior

Keep one input schema per tool/view: required fields, basic types, enum choices, documented limits and essential relationships. Trim strings, deduplicate lists, and use one basic Solana address-format check. Ignore irrelevant/unknown fields; only forward the selected view’s parameters.

Remove arbitrary query-length caps, duplicate rejection and strict nested provider validators. Preserve optional/null upstream fields, full financial precision and usable partial data. Warn on unexpected metadata rather than rejecting an otherwise useful response. Check only the top-level shape and fields required to perform a calculation or interpret a result.

Keep existing grant authorization and exact decimal conversion: these affect access and financial correctness, rather than cosmetic input validation.

All tools use the shared `source/network/fetchedAt/data/warnings` envelope, concise text and structured MCP results. Preserve source timestamps, slots, API versions and amount units. Empty data and missing prices are distinct from failures and zero balances. No automatic token selection.

Proposed transport defaults: 10-second timeout per request, at most one retry for network/transient 5xx errors, and a 30-second overall tool deadline including enrichment. For 429, retry once only if Retry-After fits the remaining deadline; otherwise return `rate_limited` and retry information. Never retry bad inputs, denied grants or provider key rejection. These are configurable transport defaults to settle during shared-contract review, not extra input restrictions.

Use one-page reads where upstream pagination exists. Preserve explicit next-page information. For tag/recent discovery, label local pagination and its lack of a stable upstream snapshot. Do not silently truncate search results or full venue mappings.

## Coverage: nine tools, 18 REST read operations

Every endpoint below uses GET on `https://api.jup.ag`. The scope contains 18 read operations. The count refers to route templates, not enum combinations or helper calls repeated by another tool.

| Tool / package module | Endpoint coverage | Work and completion criteria |
| -- | -- | -- |
| `jupiter_search_tokens` / `search-tokens.ts` | **2:** `/tokens/v2/search`; `/tokens/v2/verify/express/check-eligibility` | Query/exact-mint modes; deduplication; missing metadata; optional one-mint enrichment. Retain metadata after enrichment failure. |
| `jupiter_discover_tokens` / `discover-tokens.ts` | **3:** `/tokens/v2/{category}/{interval}`; `/tokens/v2/tag`; `/tokens/v2/recent` | Ranked/tag/recent views, correct defaults and query mapping, honest local pagination. No invented ranked next page. |
| `jupiter_get_prices` / `get-prices.ts` | **1:** `/price/v3` | Batch `ids`, documented 50-mint limit, missing-mint reporting, preserve reference-price units/precision. |
| `jupiter_get_portfolio` / `get-portfolio.ts` | **3:** `/portfolio/v1/positions/{wallet}`; `/portfolio/v1/staked-jup/{wallet}`; `/portfolio/v1/platforms` | Public wallet reads, platform filters and staking. Preserve fetcher reports and show partial results. |
| `jupiter_get_lending_markets` / `get-lending-markets.ts` | **2:** `/lend/v1/earn/tokens`; `/lend/v1/borrow/vaults` | Earn and Borrow views, `main/ethena` identity/defaults, unmodified rate units. No agent-supplied RPC URL. |
| `jupiter_get_lending_positions` / `get-lending-positions.ts` | **3:** `/lend/v1/earn/positions`; `/lend/v1/earn/earnings`; `/lend/v1/borrow/positions` | Public wallets, earnings position filters, Borrow market identity. Normalize documented object/array earnings discrepancy. |
| `jupiter_get_trigger_orders` / `get-trigger-orders.ts` | **2:** `/trigger/v1/getTriggerOrders`; `/recurring/v1/getRecurringOrders` | Public legacy price-order and time-based DCA views, using wallet address and page/has-more semantics. Keep the legacy version and maintenance status explicit. |
| `jupiter_quote_swap` / `quote-swap.ts` | **1:** `/swap/v2/order` | ExactIn quote, metadata decimals, exact integer conversion, optional constraints and safe provider quote. Omit `taker`, exclude `transaction`; no signing/submission. Reuses token search, already counted above. |
| `jupiter_get_swap_venues` / `get-swap-venues.ts` | **1:** `/swap/v2/program-id-to-label` | Complete program-ID/label mapping; no claim of pair-specific availability. |

## Implementation sequence and proposed PRs

### 1. Package foundation and Jupiter access

Create the workspace package, client/envelopes, lightweight inputs and MCP registration interface. Add `jupiter:read` to OAuth scopes/consent and a typed API service binding executor. Bind the server-managed key in the API Worker; document local/production secret setup without adding key values to source.

Verify the package imports in both Workers, the existing grant path can authorize Jupiter scope, and revoked/missing scope prevents provider calls. Existing payments/account access must still behave as before.

### 2. Token research — three tools

Implement lookup plus optional eligibility, discovery and prices. Register these through the package MCP entry point. Check exact route/parameter mapping, partial enrichment, missing prices and local discovery pagination with provider fixtures.

Depends on step 1. This gives a first useful read slice with no wallet authentication.

### 3. Portfolio and lending — three tools

Implement portfolio, lending markets and lending positions, including Borrow reads absent from Jupiter’s MCP. Keep public wallet queries independent of wallet ownership. Resolve fixture discrepancies for fetcher statuses, earnings shape and rate units before describing them as verified.

Depends on step 1; reuses step 2’s client/result helpers.

### 4. Quote and venue research — two tools

Implement quote-only requests and complete venue metadata. Reuse token lookup for missing decimals. Verify exact amount conversion and constraints, no-route handling, no `taker`, and removal of any provider transaction payload.

Depends on step 2 for token metadata. No preparation/signing/submission tools.

### 5. Public legacy orders — one tool

Implement `jupiter_get_trigger_orders` with only `legacy_price_orders` and `legacy_dca_orders`. Map `wallet` to `user`, fix DCA `recurringType=time`, and preserve explicit legacy version/maintenance and pagination fields.

Expose only these two views in the input schema. Other view values receive the normal `invalid_input` response. This tool covers legacy orders only.

Depends on step 1. This completes nine tool names with 18 read operations and no new wallet-authentication feature.

### 6. Integration verification and documentation

Confirm all nine names are discoverable and the 18 enabled endpoints match the coverage table. Check the end-to-end path from consent/grant through RPC to structured results. Document package usage, examples, supported network, pagination, API-key setup and known provider discrepancies.

Wire the new package into root `typecheck` and `test` scripts: the current scripts enumerate projects/test paths and will not automatically cover it. Add `workspace:*` imports to API/MCP and generate Worker binding types as needed.

Run affected package and existing grant tests during each stage. At final integration, run the repository’s `bun run check`; record failures or unavailable checks. Live managed-key verification is separate from deterministic fixture tests. The first three tools passed authenticated live checks; the remaining six tools require their own verification as implemented. No paid or transaction smoke tests are part of this plan.

## Focused verification

Tests should cover behavior that can fail, rather than mirror every schema rule:

* Endpoint/method/query mapping across the 18 enabled operations, including legacy `user` and fixed `recurringType=time`.
* Missing/partial results, metadata retained after failed eligibility and discovery/order pagination.
* Exact quote conversion, excess precision handling and the read-only transaction boundary.
* Existing grant revocation/scope enforcement and basic invalid-view handling.
* Bounded retry/timeout behavior without duplicate successful enrichment calls or secret leakage.

Use official examples as provisional fixtures and label them as such. Replace/add authenticated fixtures when available. Avoid rejecting newly added optional upstream fields.

## Decisions and remaining evidence

The dedicated package and lighter-validation approach are user-directed. All nine tools are planned here; the order tool supports only its two public legacy views. Private Trigger V2 reads and wallet authentication are outside this issue’s scope. Individual contract review remains one card at a time.

Before contract freeze, settle shared transport defaults and review the existing proposed 20-item operating caps for portfolio/lending inputs. Prefer documented upstream limits; do not silently present local caps as provider limits.

Provider discrepancies to record/resolve: portfolio fetcher status enum/example; Earn earnings object/array; Earn rate units; legacy order record shapes; quote-only live response and optional fields. Preserve uncertainty instead of adding strict validators to hide it.

Current evidence includes retrieved schemas, deterministic package/API grant tests, MCP discovery/calls and authenticated live reads. With a locally configured server key, query search returned 20 candidates, exact SOL lookup and eligibility succeeded, ranked/tag/recent discovery each returned the requested three records, and SOL/USDC prices returned both mints with no missing prices. All six live cases passed through an in-memory MCP client. The production Worker secret and deployed OAuth/service-binding path were not tested by these live checks; the remaining six tools are follow-up work.

Create implementation child tickets from these stages after contract sign-off, with dependencies and the completion criteria above. ADI-217 remains the planning issue.

## Contract references

1. [Token lookup](<https://linear.app/0xpratik/document/read-tool-1-jupiter-search-tokens-8a4ba57a04fa>)
2. [Token discovery](<https://linear.app/0xpratik/document/read-tool-2-jupiter-discover-tokens-d617e7ced309>)
3. [Prices](<https://linear.app/0xpratik/document/read-tool-3-jupiter-get-prices-c5aa405542e8>)
4. [Portfolio](<https://linear.app/0xpratik/document/read-tool-4-jupiter-get-portfolio-1b4f907843f7>)
5. [Lending markets](<https://linear.app/0xpratik/document/read-tool-5-jupiter-get-lending-markets-5e5a48552a63>)
6. [Lending positions](<https://linear.app/0xpratik/document/read-tool-6-jupiter-get-lending-positions-4a5bf37adc6e>)
7. [Existing orders](<https://linear.app/0xpratik/document/read-tool-7-jupiter-get-trigger-orders-ac797dc3fbee>)
8. [Quotes](<https://linear.app/0xpratik/document/read-tool-8-jupiter-quote-swap-458fa7fab81a>)
9. [Venues](<https://linear.app/0xpratik/document/read-tool-9-jupiter-get-swap-venues-f676c43e9c0c>)

[Shared access/output contract](<https://linear.app/0xpratik/document/jupiter-reads-shared-access-and-output-contract-74e4d3de90bd>)
