import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  CatalogEntry,
  CatalogList,
  CatalogSearchResponse,
} from '@lanatools/contracts'
import { listCatalog, localCatalog, searchCatalog } from '@lanatools/catalog'
import { catalog } from './catalog'
import type { CatalogEnv } from './catalog'

// Authentication is mounted by worker.ts; route tests use a known identity.
const app = new Hono<{
  Bindings: CatalogEnv
  Variables: { userId: string }
}>()
  .use(async (c, next) => {
    c.set('userId', 'catalog-test-user')
    await next()
  })
  .route('/api/catalog', catalog)

const allowed: CatalogEnv = {
  CATALOG_SEARCH_LIMITER: { limit: async () => ({ success: true }) },
}
const search = (body: unknown, env = allowed) =>
  app.request(
    '/api/catalog/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )

test('lists the same full catalog as MCP and reads every endpoint for a provider', async () => {
  const listed = await app.request('/api/catalog', {}, allowed)
  expect(listed.status).toBe(200)
  expect(CatalogList.assert(await listed.json())).toEqual(
    listCatalog(localCatalog()),
  )
  const provider = localCatalog().providers[0]
  if (!provider) throw new Error('Catalog needs a provider')
  const response = await app.request(
    `/api/catalog/entry?${new URLSearchParams({ fqn: provider.fqn })}`,
    {},
    allowed,
  )
  const entry = CatalogEntry.assert(await response.json())
  expect(response.status).toBe(200)
  expect(entry.fqn).toBe(provider.fqn)
  expect(entry.endpoints).toHaveLength(provider.endpoints.length)
  expect(
    entry.endpoints.every((endpoint) => endpoint.url.startsWith('https://')),
  ).toBe(true)
})

test('task search uses the shared ranker and filters by category', async () => {
  const response = await search({
    query: '  image generation  ',
    category: 'ai_ml',
  })
  expect(response.status).toBe(200)
  const result = CatalogSearchResponse.assert(await response.json())
  expect(result).toEqual(
    await searchCatalog(
      localCatalog(),
      { query: 'image generation', category: 'ai_ml', maxResults: 5 },
      null,
    ),
  )
  expect(result.ranker).toBe('keyword')
  expect(result.providers.length).toBeGreaterThan(0)
  expect(
    result.providers.every((provider) => provider.category === 'ai_ml'),
  ).toBe(true)
  const empty = await search({ query: 'zzzzunavailableendpointzzzz' })
  expect(CatalogSearchResponse.assert(await empty.json()).providers).toEqual([])
})

test('rejects invalid tasks, categories, malformed and oversized requests', async () => {
  for (const body of [
    null,
    {},
    { query: '' },
    { query: '   ' },
    { query: 'a'.repeat(1001) },
    { query: 5 },
    { query: 'search', category: 'missing-category' },
  ]) {
    expect((await search(body)).status).toBe(400)
  }
  expect(
    (
      await app.request(
        '/api/catalog/search',
        { method: 'POST', body: 'not JSON' },
        allowed,
      )
    ).status,
  ).toBe(400)
  expect((await search({ query: 'a'.repeat(9000) })).status).toBe(413)
  expect((await app.request('/api/catalog/entry', {}, allowed)).status).toBe(
    400,
  )
  expect(
    (await app.request('/api/catalog/entry?fqn=missing/provider', {}, allowed))
      .status,
  ).toBe(404)
})

test('limits searches by authenticated user before inference', async () => {
  let key = ''
  const response = await search(
    { query: 'search the web' },
    {
      TYPESAFE_API_KEY: 'must-not-be-used',
      CATALOG_SEARCH_LIMITER: {
        limit: async (input) => {
          key = input.key
          return { success: false }
        },
      },
    },
  )
  expect(key).toBe('catalog:catalog-test-user')
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
})
