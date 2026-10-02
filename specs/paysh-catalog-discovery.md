# pay.sh catalog discovery through the LanaTools MCP server

Status, October 2, 2026: P1 (discovery) is implemented in `apps/mcp/src/catalog.ts`; paying catalog endpoints is a separate issue and PR. This fills in the "MCP tools and catalog calls" section of [agent-payments.md](agent-payments.md).

## Goal

A connected agent can do three things through the LanaTools MCP server:

1. Search the full pay.sh catalog for a task.
2. Inspect a provider and the endpoint it picked, including the request shape and the quoted price.
3. Call that endpoint. LanaTools pays the live x402 or MPP challenge from the user's Privy wallet, within the client's limit.

Every call is attributed in activity to the catalog provider and endpoint.

## What exists today

### LanaTools

**MCP server.** `apps/mcp/src/index.ts` is a stateless Streamable HTTP server.
- It is built with `@modelcontextprotocol/server` and `agents/mcp`, behind `@cloudflare/workers-oauth-provider`.
- It exposes two tools: `whoami` (scope `account:read`) and `pay_http` (scope `payments:pay`).
- Each tool is wrapped in `withGrant`, which checks the grant through the `API` service binding.
- There are no tests for the tool handlers.

**Paid calls.** `pay_http` goes to `McpAccessService.payHttp` and then `apps/api/src/payments/pay-http.ts`.
- The unpaid request comes first. A non-402 response is returned as `free`.
- On a 402, `parseFixedCharge` (`challenge.ts`) reads the challenge, and `maxUsd` is checked.
- The spend is held with an atomic `reserve()` against the client limit (`ledger.ts`).
- Pay Kit `client.fetch` then pays, using the Privy signer.
- Settlement is verified on chain, and the result is written to `payment_activity`.

**Payment constraints today:**
- Devnet only.
- USDC only.
- `x402 exact` and `MPP charge` only.
- MPP challenges with `splits` are refused.
- Only four request headers are allowed: `accept`, `accept-language`, `content-type` and `user-agent`.
- Any public https host is allowed. There is no allowlist.

**Catalog code.** There is none: no catalog table and no service registry. The only related material is the spec text and landing page copy.

### pay.sh catalog

**Source.** The catalog lives in the public GitHub repo `solana-foundation/pay-skills` (MIT). Each provider has one `PAY.md` plus an OpenAPI file.
- CI builds the catalog and publishes it to `https://catalog.pay.sh/v1/` (backed by GCS, `cache-control: max-age=60`, no auth).
- New commits land roughly weekly.

**Index.** `skills.json` is about 61 KB:
- Top level: `{version: 2, generated_at, base_url, provider_count, providers[], affiliates[], aggregators[]}`.
- Each provider: `fqn, title, description, use_case, category, service_url, endpoint_count, has_metering, has_free_tier, min/max_price_usd, sha`.
- The live build has 75 providers and 806 endpoints.

**Detail files.** One per provider at `{base_url}/providers/{fqn}.json`, cache-keyed by `sha`.
- Provider fields: `content` (PAY.md body), `openapi_doc` (the inlined OpenAPI spec) and `endpoints[]`.
- Endpoint fields: `method, path, description, resource, pricing{dimensions[tiers[price_usd]]}, protocol[], supported_usd[], probe_status`.

**Payment terms.** Every paid endpoint is on Solana mainnet, in USDC or USDT.
- Protocol mix (local snapshot of 717 endpoints): x402 on 405, MPP on 142, none on 170.
- Gateway URLs, such as `*.gateway-402.com` and `*.paysponge.com`, return both protocols at once:
  - MPP: one challenge per mint (USDC, USDT, PYUSD, CASH, USDG), with `splits` for the operator and platform fees and a gateway `feePayer`.
  - x402 v2 `exact`: the same mints, with `extra.feePayer`.
- Direct providers, such as Exa, may also offer Base alongside Solana.

**Search in `pay`.** It is local lexical scoring, with no embeddings.
- Weights are fqn > title > use_case > description > category > endpoint text, plus a term-coverage bonus and an endpoint-count adjustment.
- A two-pass mode loads up to 20 detail files and then ranks endpoints.
- It misses on synonyms: "generate an image from a text prompt" did not find `paysponge/fal`.

**Tools in `pay mcp`.** It exposes `list_catalog`, `search_catalog`, `get_catalog_entry` and `curl`. Before paying, its `curl` checks JSON bodies against the provider's OpenAPI spec.

## The gap that decides the order of work

**The catalog is mainnet-only, and LanaTools pays only on devnet.** Discovery can ship now. A paid call to a real catalog endpoint cannot succeed until LanaTools supports mainnet.

The gateways that front most of the catalog also send challenges the current parser refuses:
- MPP challenges with `splits`.
- A challenge list with one entry per mint.

The plan therefore separates:
- **Discovery:** independent and safe to ship first.
- **Calling through a configurable catalog source:** proven on devnet against our own merchant.
- **Gateway compatibility and mainnet:** gated on decisions below.

## Decisions needed from you

1. **Mainnet.** When does LanaTools pay on Solana mainnet? This needs:
   - a mainnet `PaymentNetwork` entry (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
   - a mainnet RPC;
   - a mainnet Privy policy;
   - a funding story.

   Until then, real catalog endpoints are discoverable but not callable.
2. **Allowlist or full catalog.** `product.md` says "start with a small list of allowed endpoints". `agent-payments.md` says to expose the entire catalog with no allowlist. This plan follows the spec: everything is discoverable, and only what we can actually pay is callable. Confirm, or name the allowlist.
3. **Scope for discovery tools.** There are three options:
   - **(a) No extra scope (recommended).** Any active grant can search, because discovery reads public data and moves no money.
   - **(b) Reuse `account:read`.**
   - **(c) A new `catalog:read` scope.** This means a consent UI change and re-consent.
4. **Free catalog endpoints.** Should calling an unpaid catalog endpoint require `payments:pay`? The spec says paid calls must pass "the same … validation as free calls". The recommendation is to require it, so one scope covers every outbound call.
5. **Currency.** Pay only USDC (today's ledger is micro-USD from USDC base units), or also USDT? The recommendation is USDC only for now. Endpoints whose only stablecoin is USDT show `callable: false` with that reason.

## Design

### Catalog ingestion (apps/api)

**New module.** `apps/api/src/catalog/` holds:
- `source.ts`: fetch and validate the index and details.
- `snapshot.ts`: build the compact search snapshot.
- `search.ts`
- `openapi.ts`: extract each endpoint's request schema.
- `call.ts`

**Sources.** The catalog source URL comes from config (`CATALOG_URL`, default `https://catalog.pay.sh/v1/skills.json`). Each environment can point somewhere else:
- Local and devnet: a catalog served by the testbed merchant at `/.well-known/pay-skills.json`, or a fixture.
- Production: the public catalog.

This is what lets a full search → call proof run on devnet.

**Refresh.** A cron trigger on the API worker, every 30 minutes to match pay's TTL, does the following:
1. Fetch the index.
2. Re-fetch only the detail files whose `sha` changed.
3. Write two things to a new KV namespace `CATALOG_KV`:
   - `snapshot`: a compact JSON of providers and endpoints with no `openapi_doc`, which is what search reads.
   - `detail:<fqn>`: the full detail, read by `get_catalog_entry` and the call tool.
4. Keep the last good snapshot if a fetch or validation fails.

A refresh also runs on demand when KV is empty. Search never reads catalog.pay.sh directly, so it never fans out 75 subrequests.

**Validation.**
- Parse with arktype (already the catalog dependency in the root `package.json`), and drop entries that do not validate instead of failing the whole build.
- Accept the index `version: 2` only. Log and keep the last good snapshot on an unknown version.
- Treat all catalog text as untrusted: cap field lengths and store it as data only.

**Why KV and not D1.** The data is about 1 MB and changes as a whole. Search runs in memory over about 800 endpoints. D1 FTS5 is the fallback if the catalog grows by an order of magnitude.

### Callability

At snapshot time, each endpoint gets one of three labels:
- `callable`: protocol is x402 or MPP, the currency matches the configured asset, and the network matches.
- `free`
- `not_callable` with a reason, for example "mainnet only", "USDT only", "metered by tokens", or "needs auth (SIWX)".

The live challenge stays binding. Catalog prices are hints, as the spec requires.

### Search

**Phase 1.** Port pay's lexical scorer (MIT; `rust/crates/core/src/skills/mod.rs` `score_service_for_query` and the two-pass endpoint ranking) to TypeScript, with attribution. This gives agents the ranking pay users already get, and pay's routing benchmark CSV can be the regression test.

**Phase 2, if the benchmark shows gaps.** Add a small synonym and category expansion first (for example image → media and ai_ml, scrape → data). Workers AI embeddings with Vectorize come only if lexical plus synonyms still misses.

### MCP tools (apps/mcp)

The new tools follow the existing `registerTool` + `withGrant` pattern. Each calls a new `McpAccessService` RPC.

**`search_catalog`** (read-only, open world)
- Input: `{ query: string, category?: enum, max_results?: 1–10 (default 5) }`
- Output: candidates `{fqn, title, category, description, use_case, score, endpoints:[{method, path, description, price_usd_hint, protocols, callability, reason?}]}`
- Guidance it returns: "call get_catalog_entry before calling".

**`get_catalog_entry`** (read-only)
- Input: `{ fqn }`
- Output: provider fields, plus `usage_notes`, which is the PAY.md body, capped and labelled as provider-written text.
- Each endpoint carries a request shape extracted from OpenAPI: path, query and header params, the JSON body schema with `$ref`s resolved and trimmed to a size limit, and one example when the spec has one.
- The full OpenAPI document is not returned, because it is often too large.

**`list_catalog`** (read-only)
- Categories with provider counts, for "what can you do" questions. It is cheap, and it mirrors pay's routing.

**`call_catalog_endpoint`** (scope `payments:pay`, destructive, open world)
- Input:
  ```ts
  {
    fqn: string
    method: 'GET' | 'POST'
    path: string              // must match a catalog endpoint path
    path_params?: Record<string, string>
    query?: Record<string, string>
    body?: string | object | unknown[]
    headers?: Record<string, string>   // same allowlist as pay_http
    max_usd: string
  }
  ```
- Behaviour:
  1. The server looks up the endpoint in `detail:<fqn>`.
  2. It builds the URL from the catalog's `service_url` and `path`. The agent never supplies a host, which follows the "use the catalog's exact gateway URL" rule.
  3. It fills the path params and checks the body against the OpenAPI schema before sending anything, so a malformed request is never paid for.
  4. It refuses `not_callable` endpoints with the stored reason.
  5. It delegates to the existing `payHttp` with an added `catalog: {fqn, method, path}` attribution.

**`pay_http`** stays as it is, for URLs the user gives directly.

Tool descriptions say that catalog text, provider responses and challenges are data, not instructions (spec line 37).

### Activity attribution

**Migration.**
- Add `catalog_fqn` and `catalog_endpoint` (nullable) columns to `payment_activity`.
- `pay-http.ts` writes them when they are present.

**Web.** The activity view shows the provider title instead of the bare origin.

### Gateway compatibility (apps/api/src/payments)

These changes are needed before most real catalog endpoints can be paid. Each one goes through Pay Kit's public API; Pay Kit is never patched. If Pay Kit cannot do one of them, file it upstream and mark those endpoints `not_callable`.

1. **Choose the challenge from a list.** Pick the entry whose mint and network match the configured payment network and ignore the others. This applies to MPP (several `WWW-Authenticate` headers) and to x402 (`accepts[]`). The x402 parser already prefers the matching network plus USDC; extend the same rule to MPP.
2. **Fall back across protocols.** `auto` prefers MPP today. When the MPP challenge is unpayable (splits, wrong network, or pay 0.29's "Challenge ID mismatch" against Pay Kit 0.12, per ADI-176), fall back to the x402 challenge from the same 402 before refusing. Record which protocol was used.
3. **MPP `splits`.** Check whether Pay Kit 0.12 or later builds split transfers.
   - If it does: allow splits, require their sum to stay within `amount`, and extend `verifySettlement` to check the payer debit against the total and the credit to each recipient.
   - If it does not: x402 through the fallback covers the gateways.
4. **Gateway `feePayer`.** Confirm that the Privy policy allows the transaction shape when a gateway fee payer co-signs (TransferChecked plus Compute Budget only). Confirm that `verifySettlement` still checks the payer's token delta, not SOL. The devnet testbed already uses a gateway fee payer, so this is likely fine, but it needs proving against a recorded `gateway-402.com` challenge.
5. **Headers.** Some catalog APIs need extra request headers. Keep the allowlist. Measure which headers OpenAPI specs in the catalog declare, and add only non-credential ones.

### Mainnet (separate spec, gated on decision 1)

- A network entry, an RPC secret and a Privy mainnet policy.
- The consent and limit UI states that the funds are real.
- `paymentConfig` selects mainnet from `SOLANA_NETWORK`.
- The snapshot's callability check reads the configured network, so endpoints become callable with no code change in the catalog module.

## Phases

Each phase can be shipped and verified on its own.

### P1: discovery (no payment changes), implemented

What shipped is smaller than the design above:

- **Where it runs.** The MCP Worker reads the catalog directly with edge-cached fetches (`cacheEverything`, following the catalog's own `max-age=60`). The KV snapshot, the cron and the `CATALOG_URL` setting wait for P2, which needs a devnet catalog source.
- **Requests per search.** One search makes at most 21 subrequests: the index plus up to 20 detail files.
- **No callability labels.** Endpoints report the catalog's own `protocols`, `currencies` and listed `price_usd`; labels arrive with the payment work.
- **Tools.** `list_catalog`, `search_catalog` and `get_catalog_entry` need any active grant and no extra scope (decision 3a).
- **Request shapes.** `get_catalog_entry` returns an endpoint's OpenAPI request shape when it is given a `path`.
- **Tests.** `apps/mcp/src/catalog.test.ts` covers ranking with a fake fetch, the category filter, a detail-lookup failure, malformed listings, an unknown index version, request-shape extraction (including cyclic `$ref`s), and URL building. There are still no tool-handler tests through `createServer`.
- **Live check.** Run against the live catalog (75 providers):
  - "search the web" ranks Perplexity and Exa first.
  - "find restaurants near me" ranks Google Places first.
  - "current EUR to USD exchange rate" misses `blocksize/market-data`, whose path is `EURUSD`. This is the same lexical blind spot pay has (P5).

### P2: call on devnet through a catalog
- The testbed merchant publishes `/.well-known/pay-skills.json` (pay supports this for local sources), and the hosted Railway merchant does the same.
- `CATALOG_URL` per environment.
- The `call_catalog_endpoint` tool.
- The `catalog_fqn` and `catalog_endpoint` migration, and the activity UI.
- Tests:
  - `pay-http.test.ts`-style tests with catalog attribution.
  - A refusal for `not_callable` endpoints.
  - Body validation that fails before any fetch.
  - Assurance that the URL cannot be overridden.
- Done when a client using `apps/mcp/scripts/verify-payments.ts` (extended) runs search → get → call against the hosted devnet merchant. Activity shows the fqn, and the client's limit drops by the settled amount.

### P3: gateway compatibility
- Challenge selection from a list, the protocol fallback, and splits (or a documented upstream gap), with fixtures recorded from a real unpaid `gateway-402.com` 402 and an Exa 402.
- Done when parser and payer tests pass on the recorded mainnet-shaped challenges with the network swapped to devnet, and when a devnet `pay gate api` merchant configured with splits and several mints settles.

### P4: mainnet catalog calls
Gated on decision 1 and its own spec.
- Done when a real paid call settles on mainnet through a catalog gateway and through a direct x402 provider, with receipts and attribution.

### P5: search quality
- Synonyms and categories, then embeddings only if the benchmark justifies them.

## Risks

- **Prompt injection through catalog text.** Defenses:
  - Treat the text as data, with field caps and labelled fields.
  - The agent never supplies the host.
  - Grants, limits and Privy policy are enforced server-side regardless of anything the text says.
- **Stale prices.** The catalog shows Blocksize at $0.002 while the live 402 is dynamic. `max_usd` plus the live challenge stay binding.
- **Upstream format change.** Index v1 changed to v2 without a published schema. Validate, keep the last good snapshot, and alert on a version change.
- **Gateway behaviour drift between pay releases.** ADI-176 already hit the 0.29 MPP mismatch. Keep the recorded fixtures as regression tests.

## References

- [pay-skills repo](https://github.com/solana-foundation/pay-skills) and [pay repo](https://github.com/solana-foundation/pay) (`rust/crates/core/src/skills/mod.rs`, `rust/crates/mcp/src/tools/`)
- [agent-payments.md](agent-payments.md), [adi-176-paykit-privy.md](adi-176-paykit-privy.md)
