# Catalog package with Jev search

Status, October 4, 2026: built. The MCP catalog tools use the package; `search_catalog` uses Jev when `TYPESAFE_API_KEY` is set, with a 3 s timeout per TypeSafe request.

## Goal

When an agent calls `search_catalog`, it should get back the right provider and endpoint for the user's task. When nothing in the catalog fits, it should get no result.

Today's keyword search misses synonyms. For example, "image from a text prompt" does not find `paysponge/fal`. It also never says "no match".

## Order of work

1. **Build `packages/catalog` so it runs locally on its own**, with the scripts below. Test Jev with the catalog there.
2. **Connect it to the MCP server later**, once the local tests show Jev works. Until then, `apps/mcp` keeps its current catalog code.

## Package layout

All catalog code moves into `packages/catalog`. `apps/mcp` only registers the tools and calls the package.

```
packages/catalog/
  data/catalog.json   local copy of the catalog (committed)
  scripts/sync.ts     downloads the catalog into data/catalog.json
  scripts/search.ts   runs one search from the terminal
  scripts/eval.ts     runs the test tasks through both rankers
  src/
    source.ts     reads the local copy; fetches OpenAPI live for get_catalog_entry
    keyword.ts    today's keyword ranker (moved from apps/mcp/src/catalog.ts)
    typesafe.ts   one function that calls the TypeSafe API
    jev.ts        the Jev search (below)
    index.ts      searchCatalog, listCatalog, getCatalogEntry
```

`searchCatalog(fetcher, { query, category, maxResults }, jev)` uses Jev when `jev` (API key and timeout) is passed. It uses keyword search when it isn't, or when the TypeSafe call fails.

## Local copy

`bun run catalog:sync` downloads the index and every provider detail file. It saves them to `data/catalog.json`, which is committed to git. We rerun it by hand when the catalog changes; there is no cron.

- The copy keeps providers, endpoints and PAY.md, and drops the OpenAPI specs. That is about 0.5 MB instead of 5 MB.
- Search reads only this file. It makes no catalog network calls, and Jev always sees the same text the tests used.
- `get_catalog_entry` with a `path` still fetches that one provider's OpenAPI spec live, for the request shape.

## Running the package on its own

These run in the package with no MCP server. They need `TYPESAFE_API_KEY`.

- `bun run catalog:search "generate an image from a text prompt"` runs one search. It prints Jev's results with their probabilities and `fits` scores, keyword search's results next to them, and the latency and tokens used.
- `bun run catalog:eval` runs the test task list (see Test script) and prints the scores.

## How Jev works

`POST https://api.typesafe.ai/v1/systemone` takes:

- `state`: the input text. For us, that's `{ task: query }`.
- `questions`: named questions, all answered in one call.

We use two question types:

- **Choice**: pick one of up to 255 options. It returns a probability for every option, and that is our ranking.
- **Noul**: a yes/no question. It returns the chance the answer is yes.

Model: pin `jev-1.13.0`. The `jev-latest` alias changes when they ship a new version.

## How search works

Two calls to Jev per search.

**Call 1: pick candidates**
- Ask one Choice over every provider: "Which provider can do `task`?"
  - Each option holds the provider's title, description, use_case and category.
  - Options are sorted by name. Jev leans toward the first options, so the order must not come from another ranker.
  - Add a `none` option.
- Candidates = Jev's top 3 plus keyword search's top 3. Keyword search catches tasks that name a provider directly.

**Load details.** Read each candidate's endpoints and PAY.md from the local copy.

**Call 2: check and pick endpoints** (one request)
- `provider`: a Choice over the candidates, now including their PAY.md.
- `fits:<fqn>`: a Noul per candidate: "Can this provider do exactly what `task` asks?"
- `endpoint:<fqn>`: a Choice per candidate over its endpoints. The option key is `METHOD path`, and there is a `none` option.

**Our code decides**
- Drop candidates whose `fits` is below 0.3.
- Sort the rest by `provider` probability.
- Sort each candidate's endpoints by `endpoint` probability, and keep the top 5.
- If no candidate is left, return an empty list.

The numbers 3 (candidates) and 0.3 (cutoff) come from TypeSafe's skill-suggestion cookbook. We tune both with the test script.

## Sizes (live catalog, October 4)

| | Size | Fits in one call? |
| - | - | - |
| 75 providers | ~8.6k tokens | Yes (limit: 255 options, 32k tokens per question) |
| Largest endpoint list | 137 endpoints, ~1.7k tokens | Yes |
| Largest PAY.md | 10 KB | Yes, no trimming needed |
| `METHOD path` keys | all unique | Can be option keys |

Each search costs about $0.0005 ($0.042 per million input tokens; output is free).

## Output

`search_catalog` returns:

```ts
{
  ranker: 'jev' | 'keyword',
  providers: [{
    fqn, title, description, ...,  // same fields as today
    fits: number | null,           // Jev only
    endpoints: [{ method, path, url, price_usd, ... }],
  }],
}
```

An empty `providers` list means nothing in the catalog fits. The tool description tells agents not to retry with looser words.

## Fallback

Keyword search runs instead when:
- no `TYPESAFE_API_KEY` is set,
- TypeSafe returns an error,
- the call times out.

The timeout value is still open. We pick it after measuring latency.

## Test script

`packages/catalog/scripts/eval.ts` runs a list of tasks with known answers through both rankers. The list covers:
- synonyms
- similar providers
- tasks that name a provider
- tasks nothing in the catalog covers (Mastodon, Jupiter swap, weather)

The script reports, for each ranker:
- how often the right provider comes first
- how often the right endpoint comes first
- false matches on uncovered tasks
- latency and cost

Jev becomes the default only if it wins.

## Not in scope

- A cron to refresh the local copy.
- Any change to payments.
