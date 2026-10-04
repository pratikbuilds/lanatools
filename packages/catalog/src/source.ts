import { z } from 'zod'

/**
 * Reads the public pay.sh catalog (github.com/solana-foundation/pay-skills).
 * The index lists every provider; each provider's endpoints, usage notes and
 * OpenAPI document live in a separate detail file under the index's
 * `base_url`.
 *
 * `scripts/sync.ts` saves the index and detail files, without their OpenAPI
 * documents, to `data/catalog.json`. Search reads only that copy, so a
 * ranking never changes because the live catalog did.
 *
 * Everything here is untrusted third-party data. It is validated and
 * returned as data, and never changes what a grant may do.
 */
export const CATALOG_URL = 'https://catalog.pay.sh/v1/skills.json'

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
  sha: z.string().nullish(),
})
export type Provider = z.infer<typeof Provider>

const Endpoint = z.object({
  method: z.string(),
  path: z.string(),
  description: z.string(),
  resource: z.string().nullish(),
  pricing: z.unknown().optional(),
  protocol: z.array(z.string()).nullish(),
  supported_usd: z.array(z.string()).nullish(),
})
export type Endpoint = z.infer<typeof Endpoint>

const Index = z.object({
  version: z.literal(2),
  generated_at: z.string(),
  base_url: z.url(),
  providers: z.array(z.unknown()),
})

const Detail = z.object({
  fqn: z.string(),
  content: z.string().nullish(),
  endpoints: z.array(z.unknown()),
  openapi_doc: z.unknown().optional(),
})

const CatalogProvider = Provider.extend({
  content: z.string().nullish(),
  endpoints: z.array(Endpoint),
})
export type CatalogProvider = z.infer<typeof CatalogProvider>

const LocalCatalog = z.object({
  version: z.literal(1),
  synced_at: z.string(),
  generated_at: z.string(),
  base_url: z.url(),
  providers: z.array(CatalogProvider),
})
export type Catalog = z.infer<typeof LocalCatalog>

export class CatalogError extends Error {}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Keeps the items that pass a schema, so one malformed entry hides nothing else. */
function validItems<T>(schema: z.ZodType<T>, items: unknown[]) {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

async function getJSON(fetcher: Fetch, url: string) {
  const response = await fetcher(url)
  if (!response.ok)
    throw new CatalogError(`The catalog returned HTTP ${response.status}`)
  return response.json()
}

async function fetchIndex(fetcher: Fetch) {
  const parsed = Index.safeParse(await getJSON(fetcher, CATALOG_URL))
  if (!parsed.success || !parsed.data.base_url.startsWith('https://'))
    throw new CatalogError('The catalog index has an unsupported format')
  return {
    generatedAt: parsed.data.generated_at,
    baseURL: parsed.data.base_url.replace(/\/+$/, ''),
    providers: validItems(Provider, parsed.data.providers),
    listed: parsed.data.providers.length,
  }
}

async function fetchDetail(fetcher: Fetch, baseURL: string, fqn: string) {
  const parsed = Detail.safeParse(
    await getJSON(fetcher, `${baseURL}/providers/${fqn}.json`),
  )
  if (!parsed.success || parsed.data.fqn !== fqn)
    throw new CatalogError(`The catalog entry for ${fqn} is malformed`)
  return parsed.data
}

/**
 * Downloads the whole catalog for a local copy. A detail file that fails to
 * load fails the sync, so a copy never silently loses a provider.
 */
export async function fetchCatalog(fetcher: Fetch, now = new Date()) {
  const index = await fetchIndex(fetcher)
  const providers = await Promise.all(
    index.providers.map(async (provider) => {
      const detail = await fetchDetail(fetcher, index.baseURL, provider.fqn)
      return {
        ...provider,
        content: detail.content ?? null,
        endpoints: validItems(Endpoint, detail.endpoints),
      }
    }),
  )
  const catalog: Catalog = {
    version: 1,
    synced_at: now.toISOString(),
    generated_at: index.generatedAt,
    base_url: index.baseURL,
    providers: providers.sort((a, b) => a.fqn.localeCompare(b.fqn)),
  }
  return { catalog, dropped: index.listed - index.providers.length }
}

export function parseCatalog(data: unknown) {
  const parsed = LocalCatalog.safeParse(data)
  if (!parsed.success)
    throw new CatalogError('The local catalog copy has an unsupported format')
  return parsed.data
}

/** One provider's OpenAPI document, read live because the copy omits it. */
export async function fetchOpenAPI(
  fetcher: Fetch,
  catalog: Catalog,
  fqn: string,
) {
  return (await fetchDetail(fetcher, catalog.base_url, fqn)).openapi_doc
}
