import { type } from 'arktype'

const PriceRange = type({ min: 'number >= 0', max: 'number >= 0' }).or('null')

export const CatalogEndpoint = type({
  method: 'string',
  path: 'string',
  url: 'string',
  description: 'string',
  protocols: 'string[]',
  currencies: 'string[]',
  price_usd: PriceRange,
})
export type CatalogEndpoint = typeof CatalogEndpoint.infer

export const CatalogProvider = type({
  fqn: 'string',
  title: 'string',
  category: 'string',
  description: 'string',
  endpoint_count: 'number.integer >= 0',
  price_usd: PriceRange,
  endpoints: CatalogEndpoint.array(),
})
export type CatalogProvider = typeof CatalogProvider.infer

export const CatalogSearchRequest = type({
  query: type('string')
    .pipe((query) => query.trim())
    .to('0 < string <= 1000'),
  'category?': '0 < string <= 100',
})

export const CatalogSearchResponse = type({
  ranker: "'jev' | 'keyword'",
  providers: CatalogProvider.array(),
})
export type CatalogSearchResponse = typeof CatalogSearchResponse.infer

export const CatalogList = type({
  provider_count: 'number.integer >= 0',
  categories: type({
    category: 'string',
    providers: type({
      fqn: 'string',
      title: 'string',
      endpoint_count: 'number.integer >= 0',
    }).array(),
  }).array(),
})
export type CatalogList = typeof CatalogList.infer

export const CatalogEntry = type({
  fqn: 'string',
  title: 'string',
  category: 'string',
  description: 'string',
  usage_notes: 'string | null',
  endpoints: CatalogEndpoint.array(),
})
export type CatalogEntry = typeof CatalogEntry.infer
