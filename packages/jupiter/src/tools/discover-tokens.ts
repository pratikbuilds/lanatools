import type { ReadContext } from '../client'
import type { DiscoverTokensInput } from '../inputs'
import type { z } from 'zod'
import type { DiscoverTokensData } from '../types'

export async function discoverTokens(
  context: ReadContext,
  input: z.output<typeof DiscoverTokensInput>,
): Promise<DiscoverTokensData> {
  const ranked = input.view === 'ranked'
  const path = ranked
    ? `/tokens/v2/${input.category}/${input.interval}`
    : `/tokens/v2/${input.view}`
  const parameters = ranked
    ? { limit: String(input.limit) }
    : input.view === 'tag'
      ? { query: input.tag }
      : {}
  const all = context.tokens(await context.get(path, parameters))
  const offset = ranked ? 0 : input.offset
  const tokens = ranked ? all : all.slice(offset, offset + input.limit)
  context.warnings.push(
    ranked
      ? 'Ranked results are bounded by Jupiter; no next-page contract is available.'
      : 'Pagination slices the list returned by Jupiter locally; results are not a stable snapshot across calls.',
  )
  return {
    view: input.view,
    tokens,
    pagination: {
      limit: input.limit,
      offset,
      returned: tokens.length,
      nextOffset:
        !ranked && offset + tokens.length < all.length
          ? offset + tokens.length
          : null,
      upstreamPagination: false,
    },
  }
}
