import { z } from 'zod'

/**
 * Reads the public pay.sh catalog (github.com/solana-foundation/pay-skills).
 * The index lists every provider; each provider's endpoints and OpenAPI
 * document live in a separate detail file under the index's `base_url`.
 *
 * Everything here is untrusted third-party data. It is validated, returned to
 * agents as data, and never changes what a grant may do.
 */
export const CATALOG_URL = 'https://catalog.pay.sh/v1/skills.json'

// Search and endpoint ranking are ported from pay's MIT-licensed
// `rust/crates/core/src/skills/mod.rs` and `rust/crates/mcp/src/tools/
// search_catalog.rs`, so agents rank providers the same way pay users do.
const ENDPOINT_LOOKUP_MULTIPLIER = 3
const MAX_LOOKUPS = 20
const ENDPOINTS_PER_CANDIDATE = 5
// pay's gateway serves Google APIs under this fixed project.
const GATEWAY_PROJECT_ID = 'gateway-402'

// Slash-separated names like `solana-foundation/google/places`. Every segment
// starts with a letter or digit, so an fqn cannot walk out of the providers
// directory when it becomes part of a detail URL.
const FQN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/

const Provider = z.object({
  fqn: z.string().regex(FQN),
  title: z.string(),
  description: z.string(),
  use_case: z.string().nullish(),
  category: z.string(),
  service_url: z.url(),
  endpoint_count: z.number().int().nonnegative(),
  min_price_usd: z.number().nullish(),
  max_price_usd: z.number().nullish(),
})
type Provider = z.infer<typeof Provider>

const Index = z.object({
  version: z.literal(2),
  base_url: z.url(),
  providers: z.array(z.unknown()),
})

const Endpoint = z.object({
  method: z.string(),
  path: z.string(),
  description: z.string(),
  resource: z.string().nullish(),
  pricing: z.unknown().optional(),
  protocol: z.array(z.string()).nullish(),
  supported_usd: z.array(z.string()).nullish(),
})
type Endpoint = z.infer<typeof Endpoint>

const Detail = z.object({
  fqn: z.string(),
  content: z.string().nullish(),
  endpoints: z.array(z.unknown()),
  openapi_doc: z.unknown().optional(),
})

export class CatalogError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Keeps the items that pass a schema, so one malformed entry hides nothing else. */
function validItems<T>(schema: z.ZodType<T>, items: unknown[]) {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

async function getJSON(fetcher: Fetch, url: string) {
  // The catalog is served with `cache-control: max-age=60`; caching .json
  // subrequests at the edge needs cacheEverything.
  const response = await fetcher(url, { cf: { cacheEverything: true } })
  if (!response.ok)
    throw new CatalogError(`The catalog returned HTTP ${response.status}`)
  return response.json()
}

async function loadIndex(fetcher: Fetch) {
  const parsed = Index.safeParse(await getJSON(fetcher, CATALOG_URL))
  if (!parsed.success || !parsed.data.base_url.startsWith('https://'))
    throw new CatalogError('The catalog index has an unsupported format')
  return {
    baseURL: parsed.data.base_url.replace(/\/+$/, ''),
    providers: validItems(Provider, parsed.data.providers),
  }
}

async function loadDetail(fetcher: Fetch, baseURL: string, fqn: string) {
  const parsed = Detail.safeParse(
    await getJSON(fetcher, `${baseURL}/providers/${fqn}.json`),
  )
  if (!parsed.success || parsed.data.fqn !== fqn)
    throw new CatalogError(`The catalog entry for ${fqn} is malformed`)
  return {
    ...parsed.data,
    endpoints: validItems(Endpoint, parsed.data.endpoints),
  }
}

/** Joins a provider's service URL and an endpoint path, as pay does. */
export function endpointURL(serviceURL: string, path: string) {
  const base = serviceURL.replace(/\/+$/, '')
  const rest = path.replace(/^\/+/, '')
  if (!rest) return base
  return `${base}/${rest.replaceAll('{projectsId}', GATEWAY_PROJECT_ID).replaceAll('{project}', GATEWAY_PROJECT_ID)}`
}

/** The lowest and highest USD prices anywhere in a pricing block. */
function priceRange(pricing: unknown) {
  const prices: number[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'price_usd' && typeof inner === 'number') prices.push(inner)
        else visit(inner)
      }
  }
  visit(pricing)
  if (prices.length === 0) return null
  return { min: Math.min(...prices), max: Math.max(...prices) }
}

function describeEndpoint(provider: Provider, endpoint: Endpoint) {
  return {
    method: endpoint.method,
    path: endpoint.path,
    url: endpointURL(provider.service_url, endpoint.path),
    description: endpoint.description,
    resource: endpoint.resource ?? null,
    protocols: endpoint.protocol ?? [],
    currencies: endpoint.supported_usd ?? [],
    price_usd: priceRange(endpoint.pricing),
  }
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
  provider: Provider,
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

function scoreEndpoint(endpoint: Endpoint, query: string, terms: string[]) {
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

function rank(
  providers: Provider[],
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

/**
 * Ranks providers for a task in two passes: first on index metadata, then
 * again after loading the endpoints of the best preliminary candidates.
 */
export async function searchCatalog(
  fetcher: Fetch,
  input: { query: string; category?: string | undefined; maxResults: number },
) {
  const query = input.query.trim().toLowerCase()
  const terms = tokenize(query)
  const category = input.category?.toLowerCase()
  const index = await loadIndex(fetcher)
  const providers = category
    ? index.providers.filter((p) => p.category.toLowerCase() === category)
    : index.providers

  // A provider whose detail file fails to load is ranked without endpoints.
  const endpoints = new Map<string, Endpoint[]>()
  const lookups = Math.min(
    MAX_LOOKUPS,
    input.maxResults * ENDPOINT_LOOKUP_MULTIPLIER,
  )
  await Promise.all(
    rank(providers, endpoints, query, terms, lookups).map(({ provider }) =>
      loadDetail(fetcher, index.baseURL, provider.fqn).then(
        (detail) => endpoints.set(provider.fqn, detail.endpoints),
        () => undefined,
      ),
    ),
  )

  return rank(providers, endpoints, query, terms, input.maxResults).map(
    ({ provider, score }) => ({
      fqn: provider.fqn,
      title: provider.title,
      category: provider.category,
      description: provider.description,
      use_case: provider.use_case ?? null,
      endpoint_count: provider.endpoint_count,
      price_usd:
        provider.min_price_usd == null || provider.max_price_usd == null
          ? null
          : { min: provider.min_price_usd, max: provider.max_price_usd },
      score,
      endpoints: (endpoints.get(provider.fqn) ?? [])
        .map((endpoint) => ({
          endpoint,
          match: scoreEndpoint(endpoint, query, terms),
        }))
        .sort(
          (a, b) =>
            b.match - a.match ||
            Number(b.endpoint.pricing != null) -
              Number(a.endpoint.pricing != null) ||
            a.endpoint.path.localeCompare(b.endpoint.path),
        )
        .slice(0, ENDPOINTS_PER_CANDIDATE)
        .map(({ endpoint }) => describeEndpoint(provider, endpoint)),
    }),
  )
}

/** Groups every provider by category, for capability questions. */
export async function listCatalog(fetcher: Fetch) {
  const { providers } = await loadIndex(fetcher)
  const categories: Record<
    string,
    { fqn: string; title: string; endpoint_count: number }[]
  > = {}
  for (const { category, fqn, title, endpoint_count } of providers)
    (categories[category] ??= []).push({ fqn, title, endpoint_count })
  return {
    provider_count: providers.length,
    categories: Object.entries(categories)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, members]) => ({ category, providers: members })),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function refName(ref: string) {
  const [, section, name] = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref) ?? []
  return section && name ? { section, name } : null
}

/**
 * The OpenAPI request shape of one endpoint: its parameters and request body,
 * plus only the components they reference, so the agent can build a call
 * without receiving the provider's whole document.
 */
export function requestShape(openapi: unknown, method: string, path: string) {
  if (!isRecord(openapi) || !isRecord(openapi.paths)) return null
  const route = openapi.paths[`/${path.replace(/^\/+/, '')}`]
  if (!isRecord(route)) return null
  const operation = route[method.toLowerCase()]
  if (!isRecord(operation)) return null

  const parameters = [
    ...(Array.isArray(route.parameters) ? route.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]
  const shape = {
    summary: operation.summary ?? operation.description ?? null,
    parameters,
    requestBody: operation.requestBody ?? null,
  }

  const components = isRecord(openapi.components) ? openapi.components : {}
  const referenced: Record<string, Record<string, unknown>> = {}
  const pending: unknown[] = [shape]
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) pending.push(...value)
    else if (isRecord(value))
      for (const [key, inner] of Object.entries(value)) {
        if (key !== '$ref' || typeof inner !== 'string') {
          pending.push(inner)
          continue
        }
        const ref = refName(inner)
        if (!ref) continue
        const section = components[ref.section]
        const target = isRecord(section) ? section[ref.name] : undefined
        const seen = (referenced[ref.section] ??= {})
        if (target === undefined || ref.name in seen) continue
        seen[ref.name] = target
        pending.push(target)
      }
  }
  return { ...shape, components: referenced }
}

/** One provider's listing, optionally with one endpoint's request shape. */
export async function getCatalogEntry(
  fetcher: Fetch,
  input: {
    fqn: string
    method?: string | undefined
    path?: string | undefined
  },
) {
  const index = await loadIndex(fetcher)
  const provider = index.providers.find(
    (p) => p.fqn.toLowerCase() === input.fqn.toLowerCase(),
  )
  if (!provider) return null
  const detail = await loadDetail(fetcher, index.baseURL, provider.fqn)
  const entry = {
    fqn: provider.fqn,
    title: provider.title,
    category: provider.category,
    description: provider.description,
    use_case: provider.use_case ?? null,
    service_url: provider.service_url,
    usage_notes: detail.content ?? null,
    endpoints: detail.endpoints.map((endpoint) =>
      describeEndpoint(provider, endpoint),
    ),
  }
  if (!input.path) return entry

  const wanted = input.path.replace(/^\/+/, '')
  const atPath = detail.endpoints.filter(
    (e) => e.path.replace(/^\/+/, '') === wanted,
  )
  const endpoint = atPath.find(
    (e) =>
      !input.method || e.method.toUpperCase() === input.method.toUpperCase(),
  )
  if (!endpoint)
    throw new CatalogError(
      atPath.length === 0
        ? `${provider.fqn} has no endpoint ${input.path}`
        : `${provider.fqn} serves ${input.path} only with ${atPath.map((e) => e.method).join(', ')}`,
    )
  return {
    ...entry,
    endpoints: [describeEndpoint(provider, endpoint)],
    request: requestShape(detail.openapi_doc, endpoint.method, endpoint.path),
  }
}
