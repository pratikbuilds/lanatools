import { expect, test } from 'bun:test'
import {
  endpointURL,
  getCatalogEntry,
  jevSearch,
  keywordSearch,
  listCatalog,
  requestShape,
  searchCatalog,
} from './index'
import { CATALOG_URL, CatalogError, fetchCatalog, parseCatalog } from './source'
import { SYSTEM_ONE_URL } from './typesafe'
import type { Catalog, CatalogProvider } from './source'
import type { Question } from './typesafe'

const BASE = 'https://catalog.example/v1'

function provider(
  fqn: string,
  fields: Partial<CatalogProvider> = {},
): CatalogProvider {
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
    content: null,
    endpoints: [],
    ...fields,
  }
}

const market = provider('blocksize/market-data', {
  title: 'Blocksize Market Data',
  description: 'Institutional crypto, FX, and metals market data.',
  use_case: 'Use for live crypto prices and FX exchange rates.',
  category: 'finance',
  service_url: 'https://mcp.blocksize.info',
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
})
const search = provider('exa/search', {
  title: 'Exa',
  description: 'Neural web search for agents.',
  use_case: 'Use for web search and finding pages.',
  category: 'search',
  endpoints: [
    { method: 'POST', path: 'search', description: 'Search the web' },
  ],
})
const images = provider('paysponge/fal', {
  title: 'fal.ai',
  description: 'Generate images and videos with FLUX models.',
  category: 'media',
  endpoints: [
    {
      method: 'POST',
      path: 'fal-ai/flux/schnell',
      description: 'Submit a FLUX Schnell request',
    },
    {
      method: 'POST',
      path: 'fal-ai/stable-video',
      description: 'Submit a Stable Video request',
    },
  ],
})

const catalog: Catalog = {
  version: 1,
  synced_at: '2026-10-04T00:00:00.000Z',
  generated_at: '2026-09-30T19:00:33Z',
  base_url: BASE,
  providers: [market, images, search],
}

const OPENAPI = {
  paths: {
    '/v1/fx/EURUSD': {
      parameters: [{ $ref: '#/components/parameters/Format' }],
      get: { summary: 'Fetch FX exchange rate data' },
    },
  },
  components: { parameters: { Format: { name: 'format', in: 'query' } } },
}

/**
 * A fake TypeSafe API. `answer` gets each request's questions and returns
 * the answers; every request is recorded for inspection.
 */
function fakeJev(
  answer: (questions: Record<string, Question>) => Record<string, unknown>,
) {
  const requests: Record<string, Question>[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    expect(url).toBe(SYSTEM_ONE_URL)
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('jev-1.13.0')
    requests.push(body.questions)
    return Response.json({
      model: 'jev-1.13.0',
      answers: answer(body.questions),
      usage: { input_tokens: 100, output_tokens: 10 },
    })
  }
  return { jev: { apiKey: 'test', timeoutMs: 1000, fetch }, requests }
}

const choiceOf = (probabilities: Record<string, number>) => ({
  type: 'choice',
  choice: Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0]?.[0],
  probabilities,
  confidence: 0.5,
})
const noulOf = (value: number) => ({ type: 'noul', noul: value })

/** Answers a Choice from a table of option odds (others get 0) and Nouls by fqn. */
function answerWith(
  odds: Record<string, number>,
  fits: Record<string, number>,
  endpointOdds: Record<string, number> = {},
) {
  return (questions: Record<string, Question>) =>
    Object.fromEntries(
      Object.entries(questions).map(([key, question]) => {
        if (question.type === 'noul')
          return [key, noulOf(fits[key.slice('fits:'.length)] ?? 0)]
        const table = key.startsWith('endpoint:') ? endpointOdds : odds
        return [
          key,
          choiceOf(
            Object.fromEntries(
              Object.keys(question.criteria).map((o) => [o, table[o] ?? 0]),
            ),
          ),
        ]
      }),
    )
}

test('keyword search ranks a provider by its endpoints', () => {
  const [top] = keywordSearch(catalog, {
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

test('keyword search filters by category and finds nothing for unmatched tasks', () => {
  expect(
    keywordSearch(catalog, {
      query: 'web search',
      category: 'search',
      maxResults: 5,
    }).map((r) => r.fqn),
  ).toEqual(['exa/search'])
  expect(
    keywordSearch(catalog, { query: 'xyzzy quux', maxResults: 5 }),
  ).toEqual([])
})

test('Jev sees every provider in name order, with a none option', async () => {
  const { jev, requests } = fakeJev(
    answerWith({ 'paysponge/fal': 0.9 }, { 'paysponge/fal': 0.9 }),
  )

  await jevSearch(catalog, { query: 'draw a cat', maxResults: 5 }, jev)

  const wide = requests[0]?.provider
  expect(wide?.type).toBe('choice')
  expect(wide && Object.keys(wide.criteria ?? {})).toEqual([
    'blocksize/market-data',
    'exa/search',
    'paysponge/fal',
    'none',
  ])
})

test('Jev re-checks its own and keyword search’s top candidates', async () => {
  const { jev, requests } = fakeJev(
    answerWith(
      { 'paysponge/fal': 0.8, 'exa/search': 0.2, 'blocksize/market-data': 0 },
      { 'paysponge/fal': 0.9, 'exa/search': 0.1 },
      { 'POST fal-ai/flux/schnell': 0.7, 'POST fal-ai/stable-video': 0.3 },
    ),
  )

  const result = await jevSearch(
    catalog,
    { query: 'draw a cat with FLUX', maxResults: 5 },
    jev,
  )

  // Call 2 asks about all three candidates; keyword search contributed
  // nothing Jev did not already shortlist here.
  const narrow = requests[1] ?? {}
  expect(Object.keys(narrow).sort()).toEqual([
    'endpoint:blocksize/market-data',
    'endpoint:paysponge/fal',
    'fits:blocksize/market-data',
    'fits:exa/search',
    'fits:paysponge/fal',
    'provider',
  ])
  // Usage notes reach the re-check, and a one-endpoint provider gets no
  // endpoint question.
  expect(narrow.provider?.criteria).toMatchObject({
    'blocksize/market-data': { usage_notes: '## Spend-aware usage' },
  })
  expect('endpoint:exa/search' in narrow).toBe(false)

  // Candidates under the fit threshold are dropped.
  expect(result.providers.map((p) => p.fqn)).toEqual(['paysponge/fal'])
  expect(
    result.providers[0]?.endpoints.map((e) => [e.path, e.probability]),
  ).toEqual([
    ['fal-ai/flux/schnell', 0.7],
    ['fal-ai/stable-video', 0.3],
  ])
})

test('Jev adds keyword search’s candidates to its shortlist', async () => {
  const { jev, requests } = fakeJev(
    answerWith({ 'paysponge/fal': 1 }, { 'exa/search': 0.9 }),
  )
  const crowded: Catalog = {
    ...catalog,
    providers: [
      ...catalog.providers,
      provider('a/one'),
      provider('b/two'),
      provider('c/three'),
    ],
  }

  const result = await jevSearch(
    crowded,
    { query: 'exa web search', maxResults: 5 },
    jev,
  )

  expect(Object.keys(requests[1] ?? {})).toContain('fits:exa/search')
  expect(result.providers.map((p) => p.fqn)).toEqual(['exa/search'])
})

test('Jev returns no providers when none of them fits', async () => {
  const { jev } = fakeJev(answerWith({ none: 0.9 }, {}))

  const result = await jevSearch(
    catalog,
    { query: 'post to my Mastodon account', maxResults: 5 },
    jev,
  )

  expect(result.providers).toEqual([])
  expect(result.none).toBe(0.9)
})

test('search falls back to keyword ranking when TypeSafe fails', async () => {
  const input = { query: 'EURUSD exchange rate', maxResults: 5 }
  const failing = [
    async () => new Response('slow down', { status: 429 }),
    async () => {
      throw new DOMException('timed out', 'TimeoutError')
    },
    async () => Response.json({ model: 'jev-1.13.0', answers: {} }),
  ]
  for (const fetch of failing) {
    const result = await searchCatalog(catalog, input, {
      apiKey: 'test',
      timeoutMs: 1000,
      fetch,
    })
    expect(result.ranker).toBe('keyword')
    expect(result.providers[0]?.fqn).toBe('blocksize/market-data')
  }

  expect((await searchCatalog(catalog, input, null)).ranker).toBe('keyword')
})

test('search uses Jev when it answers', async () => {
  const { jev } = fakeJev(
    answerWith(
      { 'blocksize/market-data': 1 },
      { 'blocksize/market-data': 0.9 },
      { 'GET v1/fx/EURUSD': 1 },
    ),
  )

  const result = await searchCatalog(
    catalog,
    { query: 'euro to dollar', maxResults: 5 },
    jev,
  )

  expect(result.ranker).toBe('jev')
  expect(result.providers[0]?.endpoints[0]?.path).toBe('v1/fx/EURUSD')
})

test('sync keeps valid providers, sorted, and drops malformed listings', async () => {
  const fetch = async (url: string) => {
    if (url === CATALOG_URL)
      return Response.json({
        version: 2,
        generated_at: '2026-09-30T19:00:33Z',
        base_url: `${BASE}/`,
        providers: [
          { ...search, content: undefined, endpoints: undefined },
          { ...market, content: undefined, endpoints: undefined },
          { fqn: 'broken' },
          { ...search, fqn: '../escape' },
        ],
      })
    const fqn = url.slice(`${BASE}/providers/`.length, -'.json'.length)
    const source = catalog.providers.find((p) => p.fqn === fqn)
    return source
      ? Response.json({
          fqn,
          content: source.content,
          endpoints: [...source.endpoints, { method: 'GET' }],
          openapi_doc: OPENAPI,
        })
      : new Response('missing', { status: 404 })
  }

  const { catalog: copy, dropped } = await fetchCatalog(
    fetch,
    new Date('2026-10-04T00:00:00Z'),
  )

  expect(dropped).toBe(2)
  expect(copy.providers.map((p) => p.fqn)).toEqual([
    'blocksize/market-data',
    'exa/search',
  ])
  expect(copy.providers[0]?.endpoints).toHaveLength(2)
  expect(JSON.stringify(copy)).not.toContain('openapi')
  expect(parseCatalog(JSON.parse(JSON.stringify(copy)))).toEqual(copy)
  expect(() => parseCatalog({ version: 2 })).toThrow(CatalogError)
})

test('an entry with a path reads only that provider’s OpenAPI document live', async () => {
  const requested: string[] = []
  const fetch = async (url: string) => {
    requested.push(url)
    return Response.json({
      fqn: 'blocksize/market-data',
      endpoints: [],
      openapi_doc: OPENAPI,
    })
  }

  const entry = await getCatalogEntry(catalog, fetch, {
    fqn: 'Blocksize/Market-Data',
    method: 'GET',
    path: '/v1/fx/EURUSD',
  })

  expect(requested).toEqual([`${BASE}/providers/blocksize/market-data.json`])
  expect(entry?.usage_notes).toBe('## Spend-aware usage')
  expect(entry && 'request' in entry ? entry.request : null).toEqual({
    summary: 'Fetch FX exchange rate data',
    parameters: [{ $ref: '#/components/parameters/Format' }],
    requestBody: null,
    components: { parameters: { Format: { name: 'format', in: 'query' } } },
  })

  // Without a path, nothing is fetched.
  await getCatalogEntry(catalog, fetch, { fqn: 'exa/search' })
  expect(requested).toHaveLength(1)
  expect(
    await getCatalogEntry(catalog, fetch, { fqn: 'nobody/here' }),
  ).toBeNull()
  expect(
    getCatalogEntry(catalog, fetch, {
      fqn: 'exa/search',
      path: 'search',
      method: 'GET',
    }),
  ).rejects.toThrow('exa/search serves search only with POST')
})

test('lists providers by category', () => {
  expect(listCatalog(catalog).categories.map((c) => c.category)).toEqual([
    'finance',
    'media',
    'search',
  ])
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
