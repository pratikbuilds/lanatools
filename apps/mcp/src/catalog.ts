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
export type CatalogProvider = z.infer<typeof Provider>

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
export type CatalogEndpoint = z.infer<typeof Endpoint>

const Detail = z.object({
  fqn: z.string(),
  content: z.string().nullish(),
  endpoints: z.array(Endpoint),
  openapi_doc: z.unknown().optional(),
})
export type CatalogDetail = z.infer<typeof Detail>

export type CatalogIndex = { baseURL: string; providers: CatalogProvider[] }

export class CatalogError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

async function getJSON(fetcher: Fetch, url: string) {
  // The catalog is served with `cache-control: max-age=60`; caching .json
  // subrequests at the edge needs cacheEverything.
  const response = await fetcher(url, { cf: { cacheEverything: true } })
  if (!response.ok)
    throw new CatalogError(`The catalog returned HTTP ${response.status}`)
  return response.json()
}

export function createCatalog(fetcher: Fetch = fetch, url = CATALOG_URL) {
  let index: Promise<CatalogIndex> | undefined
  const details = new Map<string, Promise<CatalogDetail>>()

  async function readIndex(): Promise<CatalogIndex> {
    const parsed = Index.safeParse(await getJSON(fetcher, url))
    if (!parsed.success)
      throw new CatalogError('The catalog index has an unsupported format')
    const base = new URL(parsed.data.base_url)
    if (base.protocol !== 'https:')
      throw new CatalogError('The catalog index has an unsupported format')
    // One malformed listing must not hide the rest of the catalog.
    const providers = parsed.data.providers.flatMap((value) => {
      const provider = Provider.safeParse(value)
      return provider.success ? [provider.data] : []
    })
    return { baseURL: parsed.data.base_url.replace(/\/+$/, ''), providers }
  }

  function getIndex() {
    index ??= readIndex()
    return index
  }

  async function readDetail(fqn: string) {
    const { baseURL } = await getIndex()
    const parsed = Detail.safeParse(
      await getJSON(fetcher, `${baseURL}/providers/${fqn}.json`),
    )
    if (!parsed.success || parsed.data.fqn !== fqn)
      throw new CatalogError(`The catalog entry for ${fqn} is malformed`)
    return parsed.data
  }

  function getDetail(fqn: string) {
    let detail = details.get(fqn)
    if (!detail) {
      detail = readDetail(fqn)
      details.set(fqn, detail)
    }
    return detail
  }

  async function lookupProvider(fqn: string) {
    const { providers } = await getIndex()
    return providers.find((p) => p.fqn.toLowerCase() === fqn.toLowerCase())
  }

  return { getIndex, getDetail, lookupProvider }
}
export type Catalog = ReturnType<typeof createCatalog>

/** Joins a provider's service URL and an endpoint path, as pay does. */
export function endpointURL(serviceURL: string, path: string) {
  const base = serviceURL.replace(/\/+$/, '')
  const rest = path.replace(/^\/+/, '')
  if (!rest) return base
  return `${base}/${rest.replaceAll('{projectsId}', GATEWAY_PROJECT_ID).replaceAll('{project}', GATEWAY_PROJECT_ID)}`
}

/** The lowest and highest USD prices anywhere in a pricing block. */
export function priceRange(pricing: unknown) {
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

export function describeEndpoint(
  provider: CatalogProvider,
  endpoint: CatalogEndpoint,
) {
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

export function tokenize(query: string) {
  return query
    .split(/[^A-Za-z0-9]+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 1 && !STOPWORDS.has(term))
}

/** Matches whole words for short terms and tolerates naive plurals. */
export function containsTerm(haystack: string, term: string) {
  if (term.length <= 3) return haystack.split(/[^a-z0-9]+/).includes(term)
  if (haystack.includes(term) || haystack.includes(`${term}s`)) return true
  if (term.endsWith('y') && haystack.includes(`${term.slice(0, -1)}ies`))
    return true
  if (term.endsWith('ies') && haystack.includes(`${term.slice(0, -3)}y`))
    return true
  const singular = term.endsWith('s') ? term.slice(0, -1) : ''
  return singular.length > 2 && haystack.includes(singular)
}

function endpointText(endpoint: CatalogEndpoint) {
  return {
    path: endpoint.path.toLowerCase(),
    resource: (endpoint.resource ?? '').toLowerCase(),
    description: endpoint.description.toLowerCase(),
  }
}

export function scoreProvider(
  provider: CatalogProvider,
  endpoints: CatalogEndpoint[] | undefined,
  query: string,
  terms: string[],
) {
  let score = 0
  const reasons: string[] = []
  const fqn = provider.fqn.toLowerCase()
  const name = (fqn.split('/').at(-1) ?? fqn).toLowerCase()
  const title = provider.title.toLowerCase()
  const description = provider.description.toLowerCase()
  const useCase = (provider.use_case ?? '').toLowerCase()
  const category = provider.category.toLowerCase()

  if (query) {
    if (fqn.includes(query) || name.includes(query)) {
      score += 90
      reasons.push('provider name matches the task')
    }
    if (title.includes(query)) {
      score += 80
      reasons.push('provider title matches the task')
    }
    if (useCase.includes(query)) {
      score += 70
      reasons.push('provider use case directly matches the task')
    }
    if (description.includes(query)) {
      score += 55
      reasons.push('provider description matches the task')
    }
  }

  let matched = 0
  for (const term of terms) {
    const hits = [
      [containsTerm(fqn, term) || containsTerm(name, term), 24],
      [containsTerm(title, term), 18],
      [containsTerm(useCase, term), 14],
      [containsTerm(description, term), 10],
      [containsTerm(category, term), 8],
      [
        endpoints?.some((endpoint) => {
          const text = endpointText(endpoint)
          return containsTerm(
            `${text.path} ${text.resource} ${text.description}`,
            term,
          )
        }) ?? false,
        12,
      ],
    ] as const
    for (const [hit, points] of hits) if (hit) score += points
    if (hits.some(([hit]) => hit)) matched += 1
  }

  if (terms.length > 0) {
    const coverage = Math.floor((matched * 100) / terms.length)
    score += coverage
    if (coverage === 100)
      reasons.push('all important query terms match this provider')
    else if (coverage >= 50)
      reasons.push('most important query terms match this provider')
  }

  if (
    query &&
    endpoints?.some((endpoint) => {
      const text = endpointText(endpoint)
      return `${endpoint.method.toLowerCase()} ${text.path} ${text.resource} ${text.description}`.includes(
        query,
      )
    })
  ) {
    score += 45
    reasons.push('a specific endpoint matches the task')
  }

  if (provider.endpoint_count <= 5) score += 12
  else if (provider.endpoint_count <= 20) score += 6
  else if (provider.endpoint_count >= 100) score = Math.max(0, score - 8)

  const demo =
    fqn.includes('payment-debugger') || description.includes('demo api')
  const asksForDemo =
    query.includes('payment debugger') ||
    terms.some((term) => ['demo', 'debugger', 'test', 'testing'].includes(term))
  if (demo && !asksForDemo) score = Math.max(0, score - 40)

  if (score > 0 && reasons.length === 0)
    reasons.push('provider metadata partially matches the task')
  return { score, reasons }
}

export function scoreEndpoint(
  endpoint: CatalogEndpoint,
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

function rank(
  providers: CatalogProvider[],
  endpoints: Map<string, CatalogEndpoint[]>,
  query: string,
  terms: string[],
  limit: number,
) {
  return providers
    .map((provider) => ({
      provider,
      ...scoreProvider(provider, endpoints.get(provider.fqn), query, terms),
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
  catalog: Catalog,
  input: { query: string; category?: string; maxResults: number },
) {
  const query = input.query.trim().toLowerCase()
  const terms = tokenize(query)
  const { providers: all } = await catalog.getIndex()
  const providers = input.category
    ? all.filter(
        (p) => p.category.toLowerCase() === input.category?.toLowerCase(),
      )
    : all

  const endpoints = new Map<string, CatalogEndpoint[]>()
  const lookupErrors = new Map<string, string>()
  const lookups = Math.min(
    MAX_LOOKUPS,
    input.maxResults * ENDPOINT_LOOKUP_MULTIPLIER,
  )
  await Promise.all(
    rank(providers, endpoints, query, terms, lookups).map(
      async ({ provider }) => {
        try {
          endpoints.set(
            provider.fqn,
            (await catalog.getDetail(provider.fqn)).endpoints,
          )
        } catch (error) {
          lookupErrors.set(
            provider.fqn,
            error instanceof CatalogError
              ? error.message
              : 'Could not load endpoints',
          )
        }
      },
    ),
  )

  return rank(providers, endpoints, query, terms, input.maxResults).map(
    ({ provider, score, reasons }) => ({
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
      reasons,
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
      ...(lookupErrors.has(provider.fqn)
        ? { endpoint_lookup_error: lookupErrors.get(provider.fqn) }
        : {}),
    }),
  )
}

/** Groups every provider by category, for capability questions. */
export async function listCatalog(catalog: Catalog) {
  const { providers } = await catalog.getIndex()
  const categories = new Map<string, CatalogProvider[]>()
  for (const provider of providers)
    categories.set(provider.category, [
      ...(categories.get(provider.category) ?? []),
      provider,
    ])
  return {
    provider_count: providers.length,
    categories: [...categories]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, members]) => ({
        category,
        providers: members.map((p) => ({
          fqn: p.fqn,
          title: p.title,
          endpoint_count: p.endpoint_count,
        })),
      })),
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
  catalog: Catalog,
  input: {
    fqn: string
    method?: string | undefined
    path?: string | undefined
  },
) {
  const provider = await catalog.lookupProvider(input.fqn)
  if (!provider) return null
  const detail = await catalog.getDetail(provider.fqn)
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
  const endpoint = detail.endpoints.find(
    (e) =>
      e.path.replace(/^\/+/, '') === wanted &&
      (!input.method || e.method.toUpperCase() === input.method.toUpperCase()),
  )
  if (!endpoint)
    throw new CatalogError(`${provider.fqn} has no endpoint ${input.path}`)
  return {
    ...entry,
    endpoints: [describeEndpoint(provider, endpoint)],
    request: requestShape(detail.openapi_doc, endpoint.method, endpoint.path),
  }
}
