import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import {
  getCatalogEntry,
  listCatalog,
  localCatalog,
  searchCatalog,
} from '@lanatools/catalog'
import { CatalogSearchRequest } from '@lanatools/contracts'
import type {
  CatalogEntry,
  CatalogList,
  CatalogSearchResponse,
} from '@lanatools/contracts'
import type { RateLimit } from '@cloudflare/workers-types'

export type CatalogEnv = {
  TYPESAFE_API_KEY?: string
  CATALOG_SEARCH_LIMITER: RateLimit
}

// The Worker requires dashboard authentication before mounting these routes.
export const catalog = new Hono<{
  Bindings: CatalogEnv
  Variables: { userId: string }
}>()
  .use(bodyLimit({ maxSize: 8192 }))
  .get('/', (c) => c.json(listCatalog(localCatalog()) satisfies CatalogList))
  .post('/search', async (c) => {
    const input = CatalogSearchRequest(await c.req.json().catch(() => null))
    if (input instanceof type.errors) throw new HTTPException(400)
    const source = localCatalog()
    if (
      input.category &&
      !source.providers.some((p) => p.category === input.category)
    )
      throw new HTTPException(400)
    const { success } = await c.env.CATALOG_SEARCH_LIMITER.limit({
      key: `catalog:${c.get('userId')}`,
    })
    if (!success) {
      c.header('Retry-After', '60')
      throw new HTTPException(429)
    }
    const result = await searchCatalog(
      source,
      { ...input, maxResults: 5 },
      c.env.TYPESAFE_API_KEY
        ? { apiKey: c.env.TYPESAFE_API_KEY, timeoutMs: 3000 }
        : null,
    )
    return c.json(result satisfies CatalogSearchResponse)
  })
  .get('/entry', async (c) => {
    const fqn = c.req.query('fqn')
    if (!fqn || fqn.length > 200) throw new HTTPException(400)
    const entry = await getCatalogEntry(localCatalog(), fetch, { fqn })
    if (!entry) throw new HTTPException(404)
    return c.json(entry satisfies CatalogEntry)
  })
