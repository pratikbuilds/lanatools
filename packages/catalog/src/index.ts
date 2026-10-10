import local from '../data/catalog.json' with { type: 'json' }
import { jevSearch } from './jev'
import { keywordSearch } from './keyword'
import { describeEndpoint } from './shape'
import { CatalogError, fetchOpenAPI, parseCatalog } from './source'
import { TypeSafeError } from './typesafe'
import type { SearchInput } from './keyword'
import type { Catalog, Fetch } from './source'
import type { JevOpts } from './typesafe'

export { CatalogError, fetchCatalog } from './source'
export { endpointURL } from './shape'
export { jevSearch } from './jev'
export { keywordSearch } from './keyword'
export { TypeSafeError } from './typesafe'
export type { Catalog } from './source'
export type { JevOpts } from './typesafe'
export type { SearchInput } from './keyword'

let cached: Catalog | undefined

/** The committed copy in `data/catalog.json`, validated on first use. */
export function localCatalog() {
  cached ??= parseCatalog(local)
  return cached
}

/**
 * Finds providers and endpoints for a task. Uses Jev when `jev` is given
 * and falls back to keyword ranking whenever TypeSafe fails, so search
 * never depends on it being up.
 */
export async function searchCatalog(
  catalog: Catalog,
  input: SearchInput,
  jev: JevOpts | null,
) {
  if (jev)
    try {
      const { providers } = await jevSearch(catalog, input, jev)
      return { ranker: 'jev' as const, providers }
    } catch (error) {
      if (!(error instanceof TypeSafeError)) throw error
      console.error(
        JSON.stringify({
          message: 'Jev catalog search failed; using keyword ranking',
          error: error.message,
        }),
      )
    }
  return {
    ranker: 'keyword' as const,
    providers: keywordSearch(catalog, input),
  }
}

/** Groups every provider by category, for capability questions. */
export function listCatalog(catalog: Catalog) {
  const categories: Record<
    string,
    { fqn: string; title: string; endpoint_count: number }[]
  > = {}
  for (const { category, fqn, title, endpoint_count } of catalog.providers)
    (categories[category] ??= []).push({ fqn, title, endpoint_count })
  return {
    provider_count: catalog.providers.length,
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

/**
 * One provider's listing, optionally with one endpoint's request shape. The
 * request shape needs the provider's OpenAPI document, which the local copy
 * omits, so only that case reads the live catalog.
 */
export async function getCatalogEntry(
  catalog: Catalog,
  fetcher: Fetch,
  input: {
    fqn: string
    method?: string | undefined
    path?: string | undefined
  },
) {
  const provider = catalog.providers.find(
    (p) => p.fqn.toLowerCase() === input.fqn.toLowerCase(),
  )
  if (!provider) return null
  const entry = {
    fqn: provider.fqn,
    title: provider.title,
    category: provider.category,
    description: provider.description,
    use_case: provider.use_case ?? null,
    service_url: provider.service_url,
    usage_notes: provider.content ?? null,
    endpoints: provider.endpoints.map((endpoint) =>
      describeEndpoint(provider, endpoint),
    ),
  }
  if (!input.path) return entry

  const wanted = input.path.replace(/^\/+/, '')
  const atPath = provider.endpoints.filter(
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
    request: requestShape(
      await fetchOpenAPI(fetcher, catalog, provider.fqn),
      endpoint.method,
      endpoint.path,
    ),
  }
}
