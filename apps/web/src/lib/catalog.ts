import {
  CatalogEntry,
  CatalogList,
  CatalogSearchResponse,
} from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

export async function listCatalog(getAccessToken: GetAccessToken) {
  const response = await fetch('/api/catalog', {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not load the catalog. Try again.')
  return CatalogList.assert(await response.json())
}

export async function searchCatalog(
  getAccessToken: GetAccessToken,
  query: string,
  category: string,
) {
  const response = await fetch('/api/catalog/search', {
    method: 'POST',
    headers: {
      ...(await authorized(getAccessToken)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, ...(category ? { category } : {}) }),
  })
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Too many searches. Try again in a minute.'
        : 'Could not search the catalog. Try again.',
    )
  return CatalogSearchResponse.assert(await response.json())
}

export async function getCatalogEntry(
  getAccessToken: GetAccessToken,
  fqn: string,
) {
  const response = await fetch(
    `/api/catalog/entry?${new URLSearchParams({ fqn })}`,
    {
      headers: await authorized(getAccessToken),
    },
  )
  if (!response.ok) throw new Error('Could not load the endpoints. Try again.')
  return CatalogEntry.assert(await response.json())
}
