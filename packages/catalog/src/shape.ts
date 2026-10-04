import type { Endpoint, Provider } from './source'

// pay's gateway serves Google APIs under this fixed project.
const GATEWAY_PROJECT_ID = 'gateway-402'
// Endpoints returned per provider in search results.
export const ENDPOINTS_PER_CANDIDATE = 5

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

export function describeEndpoint(provider: Provider, endpoint: Endpoint) {
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

export function listing(provider: Provider) {
  return {
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
  }
}

/** Orders endpoints by a match value, preferring priced ones on ties. */
export function topEndpoints(
  endpoints: Endpoint[],
  match: (endpoint: Endpoint) => number,
) {
  return endpoints
    .map((endpoint) => ({ endpoint, match: match(endpoint) }))
    .sort(
      (a, b) =>
        b.match - a.match ||
        Number(b.endpoint.pricing != null) -
          Number(a.endpoint.pricing != null) ||
        a.endpoint.path.localeCompare(b.endpoint.path),
    )
    .slice(0, ENDPOINTS_PER_CANDIDATE)
}
