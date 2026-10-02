import { expect, test } from 'bun:test'
import {
  CatalogError,
  createCatalog,
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
    if (url === `${BASE}/skills.json`) return Response.json(index)
    const fqn = url.slice(`${BASE}/providers/`.length, -'.json'.length)
    const detail = details[fqn]
    return detail
      ? Response.json(detail)
      : new Response('missing', { status: 404 })
  }
  return { fetcher, requested }
}

test('ranks a provider by its endpoints once they are loaded', async () => {
  const { fetcher } = fakeFetch()
  const catalog = createCatalog(fetcher, `${BASE}/skills.json`)

  const [top] = await searchCatalog(catalog, {
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
  const { fetcher } = fakeFetch()
  const catalog = createCatalog(fetcher, `${BASE}/skills.json`)

  const results = await searchCatalog(catalog, {
    query: 'web search',
    category: 'search',
    maxResults: 5,
  })

  expect(results.map((r) => r.fqn)).toEqual(['exa/search'])
})

test('reports a provider whose endpoints could not load', async () => {
  const { fetcher } = fakeFetch({
    version: 2,
    base_url: BASE,
    providers: [provider('gone/away', { title: 'Weather forecasts' })],
  })
  const catalog = createCatalog(fetcher, `${BASE}/skills.json`)

  const [result] = await searchCatalog(catalog, {
    query: 'weather',
    maxResults: 5,
  })

  expect(result?.endpoints).toEqual([])
  expect(result?.endpoint_lookup_error).toBe('The catalog returned HTTP 404')
})

test('drops malformed listings and rejects an unknown index format', async () => {
  const { fetcher, requested } = fakeFetch()
  const catalog = createCatalog(fetcher, `${BASE}/skills.json`)
  const listed = await listCatalog(catalog)
  expect(listed.provider_count).toBe(2)
  expect(listed.categories.map((c) => c.category)).toEqual([
    'finance',
    'search',
  ])
  await listCatalog(catalog)
  expect(requested).toEqual([`${BASE}/skills.json`])

  const old = createCatalog(
    fakeFetch({ schema_version: '1', providers: [] }).fetcher,
    `${BASE}/skills.json`,
  )
  expect(listCatalog(old)).rejects.toBeInstanceOf(CatalogError)
})

test('returns an endpoint request shape with only referenced components', async () => {
  const { fetcher } = fakeFetch()
  const catalog = createCatalog(fetcher, `${BASE}/skills.json`)

  const entry = await getCatalogEntry(catalog, {
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
  expect(await getCatalogEntry(catalog, { fqn: 'nobody/here' })).toBeNull()
  expect(
    getCatalogEntry(catalog, { fqn: 'exa/search', path: 'nope' }),
  ).rejects.toThrow('exa/search has no endpoint nope')
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
