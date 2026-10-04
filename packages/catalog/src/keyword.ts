import { describeEndpoint, listing, topEndpoints } from './shape'
import type { Catalog, CatalogProvider, Endpoint } from './source'

// Search and endpoint ranking are ported from pay's MIT-licensed
// `rust/crates/core/src/skills/mod.rs` and `rust/crates/mcp/src/tools/
// search_catalog.rs`, so agents rank providers the same way pay users do.
const ENDPOINT_LOOKUP_MULTIPLIER = 3
const MAX_LOOKUPS = 20

export type SearchInput = {
  query: string
  category?: string | undefined
  maxResults: number
}

// Words that say nothing about which provider fits a task.
const STOPWORDS = new Set(
  'a ad an and any api are around as at by can could for from get give i idk in into is it kinda like me maybe my need of on one or our please pls quick rn some somewhere stuff that the there these they thing thingy this to up use using we what where who with'.split(
    ' ',
  ),
)

function tokenize(query: string) {
  return query
    .split(/[^A-Za-z0-9]+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 1 && !STOPWORDS.has(term))
}

/** Matches whole words for short terms and tolerates naive plurals. */
function containsTerm(haystack: string, term: string) {
  if (term.length <= 3) return haystack.split(/[^a-z0-9]+/).includes(term)
  if (haystack.includes(term) || haystack.includes(`${term}s`)) return true
  if (term.endsWith('y') && haystack.includes(`${term.slice(0, -1)}ies`))
    return true
  if (term.endsWith('ies') && haystack.includes(`${term.slice(0, -3)}y`))
    return true
  const singular = term.endsWith('s') ? term.slice(0, -1) : ''
  return singular.length > 2 && haystack.includes(singular)
}

function endpointText(endpoint: Endpoint) {
  return {
    path: endpoint.path.toLowerCase(),
    resource: (endpoint.resource ?? '').toLowerCase(),
    description: endpoint.description.toLowerCase(),
  }
}

function scoreProvider(
  provider: CatalogProvider,
  endpoints: Endpoint[] | undefined,
  query: string,
  terms: string[],
) {
  const fqn = provider.fqn.toLowerCase()
  const name = fqn.split('/').at(-1) ?? fqn
  const title = provider.title.toLowerCase()
  const description = provider.description.toLowerCase()
  const useCase = (provider.use_case ?? '').toLowerCase()
  const category = provider.category.toLowerCase()
  const endpointTexts = (endpoints ?? []).map((endpoint) => {
    const text = endpointText(endpoint)
    return `${endpoint.method.toLowerCase()} ${text.path} ${text.resource} ${text.description}`
  })

  // The whole query appearing as one phrase.
  let score = 0
  if (query) {
    if (fqn.includes(query) || name.includes(query)) score += 90
    if (title.includes(query)) score += 80
    if (useCase.includes(query)) score += 70
    if (description.includes(query)) score += 55
    if (endpointTexts.some((text) => text.includes(query))) score += 45
  }

  // Each query word, wherever it appears, plus a bonus for covering them all.
  let matched = 0
  for (const term of terms) {
    const hits = [
      [containsTerm(fqn, term) || containsTerm(name, term), 24],
      [containsTerm(title, term), 18],
      [containsTerm(useCase, term), 14],
      [containsTerm(description, term), 10],
      [containsTerm(category, term), 8],
      [endpointTexts.some((text) => containsTerm(text, term)), 12],
    ] as const
    for (const [hit, points] of hits) if (hit) score += points
    if (hits.some(([hit]) => hit)) matched += 1
  }
  if (terms.length > 0) score += Math.floor((matched * 100) / terms.length)

  // Favour focused providers, but never turn a non-match into a match.
  if (score === 0) return 0
  if (provider.endpoint_count <= 5) return score + 12
  if (provider.endpoint_count <= 20) return score + 6
  if (provider.endpoint_count >= 100) return Math.max(0, score - 8)
  return score
}

export function scoreEndpoint(
  endpoint: Endpoint,
  query: string,
  terms: string[],
) {
  const text = endpointText(endpoint)
  let score =
    query &&
    `${endpoint.method.toLowerCase()} ${text.path} ${text.resource} ${text.description}`.includes(
      query,
    )
      ? 100
      : 0
  for (const term of terms) {
    if (containsTerm(text.path, term)) score += 24
    if (containsTerm(text.resource, term)) score += 16
    if (containsTerm(text.description, term)) score += 10
  }
  return score
}

export function rank(
  providers: CatalogProvider[],
  endpoints: Map<string, Endpoint[]>,
  query: string,
  terms: string[],
  limit: number,
) {
  return providers
    .map((provider) => ({
      provider,
      score: scoreProvider(provider, endpoints.get(provider.fqn), query, terms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.provider.endpoint_count - b.provider.endpoint_count ||
        a.provider.fqn.localeCompare(b.provider.fqn),
    )
    .slice(0, limit)
}

/** The normalised query, its keywords, and the providers in scope. */
export function searchScope(catalog: Catalog, input: SearchInput) {
  const query = input.query.trim().toLowerCase()
  const category = input.category?.toLowerCase()
  return {
    query,
    terms: tokenize(query),
    providers: category
      ? catalog.providers.filter((p) => p.category.toLowerCase() === category)
      : catalog.providers,
  }
}

/**
 * Ranks providers for a task by keyword match in pay's two passes: first on
 * index metadata, then again with the endpoints of the best preliminary
 * candidates. The endpoints come from the local copy, but only those
 * candidates' endpoints count, as in pay.
 */
export function keywordSearch(catalog: Catalog, input: SearchInput) {
  const { query, terms, providers } = searchScope(catalog, input)
  const lookups = Math.min(
    MAX_LOOKUPS,
    input.maxResults * ENDPOINT_LOOKUP_MULTIPLIER,
  )
  const endpoints = new Map(
    rank(providers, new Map(), query, terms, lookups).map(({ provider }) => [
      provider.fqn,
      provider.endpoints,
    ]),
  )

  return rank(providers, endpoints, query, terms, input.maxResults).map(
    ({ provider, score }) => ({
      ...listing(provider),
      score,
      endpoints: topEndpoints(endpoints.get(provider.fqn) ?? [], (endpoint) =>
        scoreEndpoint(endpoint, query, terms),
      ).map(({ endpoint }) => describeEndpoint(provider, endpoint)),
    }),
  )
}
