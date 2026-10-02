import { expect, test } from 'bun:test'
import {
  CATALOG_URL,
  CatalogError,
  endpointURL,
  getCatalogEntry,
  listCatalog,
  requestShape,
  searchCatalog,
} from './catalog'

const BASE = 'https://catalog.example/v1'

function provider(fqn: string, fields: Record<string, unknown> = {}) {
  return {
    fqn,
    title: fqn,
    description: 'A provider',
    use_case: null,
    category: 'data',
    service_url: `https://${fqn.replace('/', '-')}.example`,
    endpoint_count: 2,
    min_price_usd: 0.001,
    max_price_usd: 0.01,
    sha: 'abc',
    ...fields,
  }
}

const market = provider('blocksize/market-data', {
  title: 'Blocksize Market Data',
  description: 'Institutional crypto, FX, and metals market data.',
  use_case: 'Use for live crypto prices and FX exchange rates.',
  category: 'finance',
  service_url: 'https://mcp.blocksize.info',
})
const search = provider('exa/search', {
  title: 'Exa',
  description: 'Neural web search for agents.',
  use_case: 'Use for web search and finding pages.',
  category: 'search',
})

const details: Record<string, unknown> = {
  'blocksize/market-data': {
    fqn: 'blocksize/market-data',
    content: '## Spend-aware usage',
    endpoints: [
      {
        method: 'GET',
        path: 'v1/bidask/BTC-USD',
        description: 'Fetch crypto bid-ask snapshot',
        pricing: { dimensions: [{ tiers: [{ price_usd: 0.002 }] }] },
        protocol: ['x402'],
        supported_usd: ['USDC'],
      },
      {
        method: 'GET',
        path: 'v1/fx/EURUSD',
        description: 'Fetch FX exchange rate data',
        pricing: { dimensions: [{ tiers: [{ price_usd: 0.005 }] }] },
        protocol: ['x402'],
        supported_usd: ['USDC'],
      },
    ],
    openapi_doc: {
      paths: {
        '/v1/fx/EURUSD': {
          parameters: [{ $ref: '#/components/parameters/Format' }],
          get: { summary: 'Fetch FX exchange rate data' },
        },
      },
      components: {
        parameters: { Format: { name: 'format', in: 'query' } },
      },
    },
  },
  'exa/search': {
    fqn: 'exa/search',
    endpoints: [
      { method: 'POST', path: 'search', description: 'Search the web' },
      { method: 'GET', description: 'An endpoint listed without a path' },
    ],
  },
}

function fakeFetch(
  index: unknown = {
    version: 2,
    base_url: BASE,
    providers: [
      market,
      search,
      { fqn: 'broken' },
      provider('../escape', { service_url: 'https://ok.example' }),
    ],
  },
) {
  const requested: string[] = []
  const fetcher = async (url: string) => {
    requested.push(url)
    if (url === CATALOG_URL) return Response.json(index)
    const fqn = url.slice(`${BASE}/providers/`.length, -'.json'.length)
    const detail = details[fqn]
    return detail
      ? Response.json(detail)
      : new Response('missing', { status: 404 })
  }
  return { fetcher, requested }
}

test('ranks a provider by its endpoints once they are loaded', async () => {
  const [top] = await searchCatalog(fakeFetch().fetcher, {
    query: 'EURUSD exchange rate',
    maxResults: 5,
  })

  expect(top?.fqn).toBe('blocksize/market-data')
  expect(top?.endpoints[0]).toEqual({
    method: 'GET',
    path: 'v1/fx/EURUSD',
    url: 'https://mcp.blocksize.info/v1/fx/EURUSD',
    description: 'Fetch FX exchange rate data',
    resource: null,
    protocols: ['x402'],
    currencies: ['USDC'],
    price_usd: { min: 0.005, max: 0.005 },
  })
})

test('filters by category and skips providers that do not match', async () => {
  const results = await searchCatalog(fakeFetch().fetcher, {
    query: 'web search',
    category: 'search',
    maxResults: 5,
  })

  expect(results.map((r) => r.fqn)).toEqual(['exa/search'])
})

test('finds nothing for a task no provider matches', async () => {
  const results = await searchCatalog(fakeFetch().fetcher, {
    query: 'xyzzy quux',
    maxResults: 5,
  })

  expect(results).toEqual([])
})

test('ranks a provider without endpoints when its detail file fails', async () => {
  const { fetcher } = fakeFetch({
    version: 2,
    base_url: BASE,
    providers: [provider('gone/away', { title: 'Weather forecasts' })],
  })

  const [result] = await searchCatalog(fetcher, {
    query: 'weather',
    maxResults: 5,
  })

  expect(result?.fqn).toBe('gone/away')
  expect(result?.endpoints).toEqual([])
})

test('drops malformed listings and rejects an unknown index format', async () => {
  const listed = await listCatalog(fakeFetch().fetcher)
  expect(listed.provider_count).toBe(2)
  expect(listed.categories.map((c) => c.category)).toEqual([
    'finance',
    'search',
  ])

  const old = fakeFetch({ schema_version: '1', providers: [] }).fetcher
  expect(listCatalog(old)).rejects.toBeInstanceOf(CatalogError)
})

test('returns an endpoint request shape with only referenced components', async () => {
  const { fetcher } = fakeFetch()

  const entry = await getCatalogEntry(fetcher, {
    fqn: 'Blocksize/Market-Data',
    method: 'GET',
    path: '/v1/fx/EURUSD',
  })

  expect(entry?.usage_notes).toBe('## Spend-aware usage')
  expect(entry?.endpoints.map((e) => e.path)).toEqual(['v1/fx/EURUSD'])
  expect(entry && 'request' in entry ? entry.request : null).toEqual({
    summary: 'Fetch FX exchange rate data',
    parameters: [{ $ref: '#/components/parameters/Format' }],
    requestBody: null,
    components: { parameters: { Format: { name: 'format', in: 'query' } } },
  })
  expect(await getCatalogEntry(fetcher, { fqn: 'nobody/here' })).toBeNull()
})

test('keeps valid endpoints and explains a missing path or method', async () => {
  const { fetcher } = fakeFetch()

  const entry = await getCatalogEntry(fetcher, { fqn: 'exa/search' })
  expect(entry?.endpoints.map((e) => e.path)).toEqual(['search'])
  expect(
    getCatalogEntry(fetcher, { fqn: 'exa/search', path: 'nope' }),
  ).rejects.toThrow('exa/search has no endpoint nope')
  expect(
    getCatalogEntry(fetcher, {
      fqn: 'exa/search',
      path: 'search',
      method: 'GET',
    }),
  ).rejects.toThrow('exa/search serves search only with POST')
})

test('follows schema references without looping on cycles', () => {
  const shape = requestShape(
    {
      paths: {
        '/v1/tree': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Node' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            properties: { child: { $ref: '#/components/schemas/Node' } },
          },
          Unused: { type: 'string' },
        },
      },
    },
    'POST',
    'v1/tree',
  )

  expect(Object.keys(shape?.components.schemas ?? {})).toEqual(['Node'])
})

test('builds endpoint URLs the way pay does', () => {
  expect(endpointURL('https://gw.example.com/', '')).toBe(
    'https://gw.example.com',
  )
  expect(
    endpointURL('https://gw.example.com', '/v2/projects/{projectsId}/queries'),
  ).toBe('https://gw.example.com/v2/projects/gateway-402/queries')
})
